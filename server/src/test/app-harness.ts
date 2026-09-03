import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Kysely } from 'kysely';
import { createAppModule } from '../app.module.js';
import { AccountsService } from '../auth/accounts.service.js';
import { AuthService } from '../auth/auth.service.js';
import { hashPassword } from '../auth/password.js';
import { LiveCache } from '../collect/live-cache.js';
import type { Config } from '../config.js';
import { AccountEventsRepo } from '../db/account-events.repo.js';
import { AccountsRepo } from '../db/accounts.repo.js';
import { createDb } from '../db/connect.js';
import { SQLITE_SQL } from '../db/dialect.js';
import { IntegrationStateRepo } from '../db/integration-state.repo.js';
import { LoginAttemptsRepo } from '../db/login-attempts.repo.js';
import { migrateToLatest } from '../db/migrate.js';
import { NodeSamplesRepo } from '../db/node-samples.repo.js';
import type { Database } from '../db/schema.js';
import { SessionsRepo } from '../db/sessions.repo.js';
import { HealthService } from '../health.service.js';
import { CapabilitiesService } from '../plugins/capabilities.service.js';
import type { IntegrationModule } from '../plugins/contract.js';
import { DetectionService } from '../plugins/detection.service.js';
import { IntegrationRegistry } from '../plugins/registry.js';
import { FacetQuery } from '../query/facet-query.js';
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
  config: Config;
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
  const capabilities = new CapabilitiesService({
    registry,
    states,
    detection,
    clusterFacts: async () => ({ version: 'v1.36.3', nodes: 4 }),
    agentStatus: async () => ({ installed: false, reporting: 0, expected: 4, stale: [] }),
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
    config,
    async close() {
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
): Promise<void> {
  await harness.accounts.create(
    { username, passwordHash: await hashPassword(TEST_PASSWORD), mustChangePassword },
    Date.now(),
  );
}
