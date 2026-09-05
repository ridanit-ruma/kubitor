import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createAppModule } from './app.module.js';
import { AccountsService } from './auth/accounts.service.js';
import { AuthService } from './auth/auth.service.js';
import { coreIntegration } from './collect/core.integration.js';
import { HostIngest } from './collect/host-ingest.js';
import { LiveCache } from './collect/live-cache.js';
import { CollectorScheduler } from './collect/scheduler.js';
import { loadConfig } from './config.js';
import { AccountEventsRepo } from './db/account-events.repo.js';
import { AccountsRepo } from './db/accounts.repo.js';
import { AgentTokensRepo } from './db/agent-tokens.repo.js';
import { createDb } from './db/connect.js';
import { sqlFor } from './db/dialect.js';
import { IntegrationStateRepo } from './db/integration-state.repo.js';
import { LoginAttemptsRepo } from './db/login-attempts.repo.js';
import { migrateToLatest } from './db/migrate.js';
import { NodeSamplesRepo } from './db/node-samples.repo.js';
import { sweepRetention } from './db/retention.js';
import { SessionsRepo } from './db/sessions.repo.js';
import { TABLES } from './db/tables.js';
import { HealthService } from './health.service.js';
import { LiveGateway } from './http/ws.gateway.js';
import { hostAgentIntegration } from './integrations/host-agent/index.js';
import { traefikIntegration } from './integrations/traefik/index.js';
import { KubeClient } from './kube/client.js';
import { clusterProbes } from './kube/probes.js';
import { clusterJwksReader, ownNamespace, ServiceAccountVerifier } from './kube/sa-token.js';
import { CapabilitiesService } from './plugins/capabilities.service.js';
import { DETECTION_INTERVAL_MS, DetectionService } from './plugins/detection.service.js';
import { INTEGRATIONS } from './plugins/index.js';
import { IngestPipeline } from './plugins/ingest.js';
import { unavailableProbes } from './plugins/probes/unavailable.js';
import { IntegrationRegistry } from './plugins/registry.js';
import { FacetQuery } from './query/facet-query.js';

const BOOTSTRAP_USERNAME = 'admin';
/** Pruning runs often enough that a burst cannot outrun it. */
const RETENTION_INTERVAL_MS = 10 * 60_000;
/**
 * How often a kubelet sample is written down.
 *
 * The kubelet is read every five seconds so the dashboard moves; only one
 * reading in fifteen reaches the database. Storing at the sampling rate is how
 * a SQLite file on one PVC gets destroyed.
 */
const SAMPLE_PERSIST_INTERVAL_MS = 15_000;
/** This build, baked in by CI. Reported so the client never shows the cluster's. */
const KUBITOR_VERSION = process.env.KUBITOR_VERSION ?? 'dev';
/** The audience the agent's projected token must carry. */
const AGENT_TOKEN_AUDIENCE = 'kubitor';
/** The largest ingest request accepted, with room above what the agent sends. */
const MAX_INGEST_BODY = '1mb';
/** The only service account whose projected token may report host metrics. */
const AGENT_SERVICE_ACCOUNT = process.env.KUBITOR_AGENT_SERVICE_ACCOUNT ?? 'kubitor-agent';

async function bootstrap(): Promise<void> {
  const logger = new Logger('kubitor');
  const config = loadConfig(process.env);

  const db = createDb(config.db);
  await migrateToLatest(db, config.db.kind);

  const dialect = sqlFor(config.db.kind);
  const accountsRepo = new AccountsRepo(db);
  const sessionsRepo = new SessionsRepo(db);
  const eventsRepo = new AccountEventsRepo(db, dialect);

  const auth = new AuthService({
    accounts: accountsRepo,
    sessions: sessionsRepo,
    attempts: new LoginAttemptsRepo(db),
    events: eventsRepo,
    sessionTtlMs: config.sessionTtlMs,
  });
  const accounts = new AccountsService({
    accounts: accountsRepo,
    sessions: sessionsRepo,
    events: eventsRepo,
  });

  const seeded = await accounts.bootstrap(
    BOOTSTRAP_USERNAME,
    config.adminInitialPassword,
    Date.now(),
  );
  if (seeded.generatedPassword) {
    // Printed once, never stored in the clear. The account must change it on
    // first sign-in anyway.
    logger.warn(
      `No KUBITOR_ADMIN_INITIAL_PASSWORD was set. Created "${BOOTSTRAP_USERNAME}" with password: ${seeded.generatedPassword}`,
    );
  } else if (seeded.created) {
    logger.log(`Created the initial "${BOOTSTRAP_USERNAME}" account.`);
  }

  // Kubernetes access is optional: without it the server still serves accounts
  // and reports every integration as `unknown` rather than pretending they are
  // absent.
  let kube: KubeClient | null = null;
  try {
    kube = KubeClient.fromCluster();
    await kube.serverVersion();
  } catch (error) {
    kube = null;
    logger.warn(`No Kubernetes access: ${String(error)}`);
  }

  const liveCache = new LiveCache();
  const samples = new NodeSamplesRepo(db);
  const pipeline = new IngestPipeline(db, dialect);
  const query = new FacetQuery(db, dialect);
  const agentTokens = new AgentTokensRepo(db);

  const hostIngest = new HostIngest({ cache: liveCache, pipeline });

  // Verifying a projected token needs the cluster's public keys, so this only
  // exists in a cluster. Elsewhere the static per-node tokens remain the way in.
  const namespace = await ownNamespace();
  const saVerifier =
    kube && namespace
      ? new ServiceAccountVerifier({
          jwks: clusterJwksReader(),
          audience: AGENT_TOKEN_AUDIENCE,
          namespace,
          serviceAccount: AGENT_SERVICE_ACCOUNT,
          now: () => Date.now(),
        })
      : null;

  if (kube && !namespace) {
    logger.warn('No service-account namespace on disk; agents must use static tokens.');
  }

  let nodeCount = 0;
  const hostAgent = hostAgentIntegration({
    reporting: () => liveCache.reportingHosts(Date.now()),
    expected: () => nodeCount,
  });

  const persistedAt = new Map<string, number>();
  const modules = kube
    ? [
        coreIntegration(kube, async (sample) => {
          liveCache.record(sample);

          // Every sample reaches the cache; one in fifteen seconds reaches disk.
          const last = persistedAt.get(sample.node) ?? 0;
          if (sample.at - last < SAMPLE_PERSIST_INTERVAL_MS) return;
          persistedAt.set(sample.node, sample.at);
          await samples.record(sample);
        }),
        traefikIntegration(kube),
        hostAgent,
        ...INTEGRATIONS,
      ]
    : [hostAgent, ...INTEGRATIONS];

  const probes = kube ? clusterProbes(kube) : unavailableProbes();
  const registry = new IntegrationRegistry(modules);
  const detection = new DetectionService({
    registry,
    states: new IntegrationStateRepo(db, dialect),
    probes,
  });
  // Detection is what decides whether the agent's screens exist, so a node
  // appearing for the first time re-runs it rather than waiting out the
  // five-minute sweep. Wired here because it needs the detection service, which
  // in turn needs the module list the agent belongs to.
  hostIngest.onFirstReport((node) => {
    void detection.runOnce(Date.now()).catch((error: unknown) => {
      logger.warn(`Detection after ${node} first reported failed: ${String(error)}`);
    });
  });

  const capabilities = new CapabilitiesService({
    version: KUBITOR_VERSION,
    registry,
    states: new IntegrationStateRepo(db, dialect),
    detection,
    clusterFacts: async () => ({
      version: kube ? await kube.serverVersion() : 'unknown',
      nodes: kube ? (await kube.listNodes()).length : 0,
    }),
    agentStatus: async () => {
      const now = Date.now();
      const reporting = liveCache.reportingHosts(now);
      const known = await agentTokens.list();
      const expected = kube ? (await kube.listNodes()).length : reporting.length;

      return {
        // "Installed" means a node has actually reported, not that a manifest
        // exists: a DaemonSet that cannot reach the server is not installed
        // from the dashboard's point of view.
        installed: reporting.length > 0,
        reporting: reporting.length,
        expected,
        stale: known
          .map((token) => token.node)
          .filter((node) => !reporting.includes(node))
          .sort(),
      };
    },
  });

  const scheduler = new CollectorScheduler({
    pipeline,
    probes,
    now: () => Date.now(),
    onError: (collectorId, error) =>
      logger.warn(`Collector ${collectorId} failed: ${String(error)}`),
  });
  scheduler.start(modules);

  /**
   * Capacity is what turns a raw gauge into a percentage, and the node count is
   * what makes partial agent coverage visible.
   *
   * Refreshed rather than read once at boot: a node joining the cluster an hour
   * later would otherwise have no capacity, and every percentage for it would
   * read as unknown for as long as the pod lived.
   */
  const refreshNodeFacts = async (): Promise<void> => {
    if (!kube) return;

    const nodes = await kube.listNodes();
    nodeCount = nodes.length;
    for (const node of nodes) {
      liveCache.setCapacity(node.name, {
        cpuMilli: node.capacityCpuMilli,
        memoryBytes: node.capacityMemoryBytes,
      });
    }
  };

  await refreshNodeFacts();

  // Detection reads the node count above, so the first sweep runs after it.
  await detection.runOnce(Date.now());

  const detectionTimer = setInterval(() => {
    void refreshNodeFacts()
      .then(() => detection.runOnce(Date.now()))
      .catch((error: unknown) => {
        logger.error(`Detection sweep failed: ${String(error)}`);
      });
  }, DETECTION_INTERVAL_MS);
  detectionTimer.unref();

  const retentionTimer = setInterval(() => {
    void sweepRetention(db, TABLES, Date.now()).catch((error: unknown) => {
      logger.error(`Retention sweep failed: ${String(error)}`);
    });
  }, RETENTION_INTERVAL_MS);
  retentionTimer.unref();

  const app = await NestFactory.create<NestExpressApplication>(
    createAppModule({
      config,
      health: new HealthService(db),
      auth,
      accounts,
      capabilities,
      query,
      samples,
      liveCache,
      pipeline,
      agentTokens,
      hostIngest,
      saVerifier,
    }),
  );

  // The ingress terminates TLS and sets the forwarded headers we read.
  app.set('trust proxy', true);
  // Express defaults to 100 kB, which an agent's backlog outgrew the moment a
  // reading started carrying memory modules, sensors, interfaces and drives:
  // every reading buffered during a restart came back as 413 and was dropped.
  // The agent bounds its own request at half of this.
  app.useBodyParser('json', { limit: MAX_INGEST_BODY });
  app.enableShutdownHooks();

  const gateway = new LiveGateway({
    auth,
    cache: liveCache,
    sessionSecret: config.sessionSecret,
    logger,
    now: () => Date.now(),
  });

  const shutdown = async (): Promise<void> => {
    clearInterval(detectionTimer);
    clearInterval(retentionTimer);
    scheduler.stop();
    await gateway.close();
    await app.close();
    await db.destroy();
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());

  await app.listen(config.port, '0.0.0.0');
  gateway.attach(app.getHttpServer());
  logger.log(`Listening on ${config.port}`);
}

await bootstrap();
