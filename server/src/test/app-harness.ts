import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Kysely } from 'kysely';
import { AlertsService } from '../alerts/service.js';
import { createAppModule } from '../app.module.js';
import { AccountsService } from '../auth/accounts.service.js';
import { AgentsService } from '../auth/agents.service.js';
import { AuthService } from '../auth/auth.service.js';
import { hashPassword } from '../auth/password.js';
import { BackupRunner } from '../backup/runner.js';
import { HostIngest } from '../collect/host-ingest.js';
import { LiveCache } from '../collect/live-cache.js';
import type { Config } from '../config.js';
import { AccountEventsRepo } from '../db/account-events.repo.js';
import { AccountsRepo } from '../db/accounts.repo.js';
import { AgentTokensRepo } from '../db/agent-tokens.repo.js';
import { AlertsRepo } from '../db/alerts.repo.js';
import { BackupsRepo } from '../db/backups.repo.js';
import { createDb } from '../db/connect.js';
import { SQLITE_SQL } from '../db/dialect.js';
import { IntegrationStateRepo } from '../db/integration-state.repo.js';
import { LoginAttemptsRepo } from '../db/login-attempts.repo.js';
import { migrateToLatest } from '../db/migrate.js';
import { NodeSamplesRepo } from '../db/node-samples.repo.js';
import { NotificationsRepo } from '../db/notifications.repo.js';
import type { Database } from '../db/schema.js';
import { SessionsRepo } from '../db/sessions.repo.js';
import { SettingsRepo } from '../db/settings.repo.js';
import { HealthService } from '../health.service.js';
import { Dispatcher } from '../notify/dispatcher.js';
import { channelSource } from '../notify/source.js';
import { CapabilitiesService } from '../plugins/capabilities.service.js';
import type { IntegrationModule } from '../plugins/contract.js';
import { DetectionService } from '../plugins/detection.service.js';
import { IngestPipeline } from '../plugins/ingest.js';
import { IntegrationRegistry } from '../plugins/registry.js';
import { FacetQuery } from '../query/facet-query.js';
import { sealerFor } from '../settings/secrets.js';
import { SettingsService } from '../settings/service.js';
import { type FakeClusterState, fakeProbes } from './fake-probes.js';

export interface TestApp {
  app: INestApplication;
  db: Kysely<Database>;
  accounts: AccountsRepo;
  sessions: SessionsRepo;
  auth: AuthService;
  accountsService: AccountsService;
  capabilities: CapabilitiesService;
  detection: DetectionService;
  query: FacetQuery;
  samples: NodeSamplesRepo;
  liveCache: LiveCache;
  pipeline: IngestPipeline;
  agentTokens: AgentTokensRepo;
  hostIngest: HostIngest;
  config: Config;
  settings: SettingsService;
  backup: BackupRunner;
  /** Every line the composed application logged, in order. */
  logs: string[];
  close(): Promise<void>;
}

export const TEST_PASSWORD = 'a-good-test-password';

/**
 * A real application over a real SQLite file — no mocked guards, no stubbed
 * repositories. HTTP behaviour is what these tests are for, so the only thing
 * shortened is the anti-enumeration delay.
 */
export interface TestAppOptions {
  config?: Partial<Config>;
  integrations?: readonly IntegrationModule[];
  cluster?: FakeClusterState;
  /** Cluster node names, for the routes that mark a credential as a node's. */
  nodeNames?: readonly string[];
}

export async function createTestApp(options: TestAppOptions = {}): Promise<TestApp> {
  const overrides = options.config ?? {};
  const directory = mkdtempSync(join(process.cwd(), '.tmptest', 'app-'));
  const db = createDb({ kind: 'sqlite', sqlitePath: join(directory, 'test.db') });
  await migrateToLatest(db, 'sqlite');

  const config: Config = {
    port: 0,
    db: { kind: 'sqlite', sqlitePath: join(directory, 'test.db') },
    sessionSecret: randomUUID().repeat(2),
    sessionTtlMs: 3_600_000,
    trustedProxyHeader: 'cf-connecting-ip',
    cookieSecure: true,
    notify: { minimumSeverity: 'warning' },
    ...overrides,
  };

  const accounts = new AccountsRepo(db);
  const sessions = new SessionsRepo(db);
  const events = new AccountEventsRepo(db, SQLITE_SQL);
  const auth = new AuthService({
    accounts,
    sessions,
    attempts: new LoginAttemptsRepo(db),
    events,
    sessionTtlMs: config.sessionTtlMs,
    failedLoginDelayMs: 0,
  });
  const accountsService = new AccountsService({ accounts, sessions, events });

  const registry = new IntegrationRegistry([...(options.integrations ?? [])]);
  const states = new IntegrationStateRepo(db, SQLITE_SQL);
  const detection = new DetectionService({
    registry,
    states,
    probes: fakeProbes(options.cluster ?? {}),
  });
  const query = new FacetQuery(db, SQLITE_SQL);
  const samples = new NodeSamplesRepo(db);
  const liveCache = new LiveCache();
  const pipeline = new IngestPipeline(db, SQLITE_SQL);
  const agentTokens = new AgentTokensRepo(db);
  const agents = new AgentsService(agentTokens);
  // Everything below is wired the way `main.ts` wires it, and for one reason:
  // a harness that composes the application differently from the composition
  // root tests a program nobody runs. It passed no logger and no backup runner
  // once, and the cost was a settings document that could put the real server
  // into a boot loop with every test still green.
  const logs: string[] = [];
  const log = (message: string): void => {
    logs.push(message);
  };

  const settings = await SettingsService.load({
    repo: new SettingsRepo(db, SQLITE_SQL),
    sealer: await sealerFor(config.settingsKey),
    seed: { notify: config.notify, backup: config.backup ?? null },
    ...(config.backupAgeIdentity === undefined ? {} : { ageIdentity: config.backupAgeIdentity }),
    now: () => Date.now(),
    log,
  });
  const notifications = new NotificationsRepo(db);
  const dispatcher = new Dispatcher({
    channels: channelSource(() => settings.notify, log),
    notifications,
    alerts: new AlertsRepo(db, SQLITE_SQL),
    deps: { fetch: globalThis.fetch, baseUrl: null },
    now: () => Date.now(),
    log,
  });
  const backupRecords = new BackupsRepo(db);
  // Always constructed, as in `main.ts`: the destination lives in the database,
  // so a server that boots without one must be able to acquire one. Never
  // started here — nothing in a test should be waiting for a cron minute.
  const backup = new BackupRunner({
    config: () => settings.backup,
    db,
    records: backupRecords,
    now: () => new Date(),
    workDir: directory,
    log,
  });
  const alerts = new AlertsService({
    db,
    alerts: new AlertsRepo(db, SQLITE_SQL),
    backups: () => (settings.backup ? backupRecords : null),
    staleAgents: async () => [],
    now: () => Date.now(),
  });
  const hostIngest = new HostIngest({ cache: liveCache, pipeline });
  const capabilities = new CapabilitiesService({
    version: 'test',
    registry,
    states,
    detection,
    clusterFacts: async () => ({ version: 'v1.36.3', nodes: 4 }),
    agentStatus: async () => ({
      installed: false,
      reporting: 0,
      expected: 4,
      standalone: 0,
      stale: [],
    }),
  });

  const moduleRef = await Test.createTestingModule({
    imports: [
      createAppModule({
        config,
        health: new HealthService(db),
        auth,
        accounts: accountsService,
        capabilities,
        query,
        samples,
        liveCache,
        pipeline,
        agentTokens,
        agents,
        nodeNames: async () => [...(options.nodeNames ?? [])],
        backup,
        alerts,
        notifications,
        dispatcher,
        hostIngest,
        // No cluster here, so no projected token can be verified: the harness
        // exercises the static-token path, as an out-of-cluster agent would.
        saVerifier: null,
        settings,
        events,
      }),
    ],
  }).compile();

  const app = moduleRef.createNestApplication();
  await app.init();

  return {
    app,
    db,
    accounts,
    sessions,
    auth,
    accountsService,
    capabilities,
    detection,
    query,
    samples,
    liveCache,
    pipeline,
    agentTokens,
    hostIngest,
    config,
    settings,
    backup,
    logs,
    async close() {
      backup.stop();
      await app.close();
      await db.destroy();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

export async function seedAccount(
  harness: TestApp,
  username: string,
  mustChangePassword = false,
  role = 'admin',
): Promise<void> {
  await harness.accounts.create(
    { username, role, passwordHash: await hashPassword(TEST_PASSWORD), mustChangePassword },
    Date.now(),
  );
}
