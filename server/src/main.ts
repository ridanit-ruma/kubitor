import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createAppModule } from './app.module.js';
import { AccountsService } from './auth/accounts.service.js';
import { AuthService } from './auth/auth.service.js';
import { coreIntegration } from './collect/core.integration.js';
import { LiveCache } from './collect/live-cache.js';
import { CollectorScheduler } from './collect/scheduler.js';
import { loadConfig } from './config.js';
import { AccountEventsRepo } from './db/account-events.repo.js';
import { AccountsRepo } from './db/accounts.repo.js';
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
import { KubeClient } from './kube/client.js';
import { clusterProbes } from './kube/probes.js';
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

  const modules = kube
    ? [
        coreIntegration(kube, async (sample) => {
          liveCache.record(sample);
          await samples.record(sample);
        }),
        ...INTEGRATIONS,
      ]
    : INTEGRATIONS;

  const probes = kube ? clusterProbes(kube) : unavailableProbes();
  const registry = new IntegrationRegistry(modules);
  const detection = new DetectionService({
    registry,
    states: new IntegrationStateRepo(db, dialect),
    probes,
  });
  const capabilities = new CapabilitiesService({
    registry,
    states: new IntegrationStateRepo(db, dialect),
    detection,
    clusterFacts: async () => ({
      version: kube ? await kube.serverVersion() : 'unknown',
      nodes: kube ? (await kube.listNodes()).length : 0,
    }),
    agentStatus: async () => ({ installed: false, reporting: 0, expected: 0, stale: [] }),
  });

  await detection.runOnce(Date.now());
  const detectionTimer = setInterval(() => {
    void detection.runOnce(Date.now()).catch((error: unknown) => {
      logger.error(`Detection sweep failed: ${String(error)}`);
    });
  }, DETECTION_INTERVAL_MS);
  detectionTimer.unref();

  const scheduler = new CollectorScheduler({
    pipeline,
    probes,
    now: () => Date.now(),
    onError: (collectorId, error) =>
      logger.warn(`Collector ${collectorId} failed: ${String(error)}`),
  });
  scheduler.start(modules);

  // Capacity is what turns a raw gauge into a percentage.
  if (kube) {
    for (const node of await kube.listNodes()) {
      liveCache.setCapacity(node.name, {
        cpuMilli: node.capacityCpuMilli,
        memoryBytes: node.capacityMemoryBytes,
      });
    }
  }

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
    }),
  );

  // The ingress terminates TLS and sets the forwarded headers we read.
  app.set('trust proxy', true);
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
