import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createAppModule } from './app.module.js';
import { AccountsService } from './auth/accounts.service.js';
import { AuthService } from './auth/auth.service.js';
import { loadConfig } from './config.js';
import { AccountEventsRepo } from './db/account-events.repo.js';
import { AccountsRepo } from './db/accounts.repo.js';
import { createDb } from './db/connect.js';
import { sqlFor } from './db/dialect.js';
import { IntegrationStateRepo } from './db/integration-state.repo.js';
import { LoginAttemptsRepo } from './db/login-attempts.repo.js';
import { migrateToLatest } from './db/migrate.js';
import { SessionsRepo } from './db/sessions.repo.js';
import { HealthService } from './health.service.js';
import { CapabilitiesService } from './plugins/capabilities.service.js';
import { DETECTION_INTERVAL_MS, DetectionService } from './plugins/detection.service.js';
import { INTEGRATIONS } from './plugins/index.js';
import { unavailableProbes } from './plugins/probes/unavailable.js';
import { IntegrationRegistry } from './plugins/registry.js';

const BOOTSTRAP_USERNAME = 'admin';

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

  const registry = new IntegrationRegistry(INTEGRATIONS);
  const detection = new DetectionService({
    registry,
    states: new IntegrationStateRepo(db, dialect),
    probes: unavailableProbes(),
  });
  const capabilities = new CapabilitiesService({
    registry,
    states: new IntegrationStateRepo(db, dialect),
    detection,
    clusterFacts: async () => ({ version: 'unknown', nodes: 0 }),
    agentStatus: async () => ({ installed: false, reporting: 0, expected: 0, stale: [] }),
  });

  await detection.runOnce(Date.now());
  const detectionTimer = setInterval(() => {
    void detection.runOnce(Date.now()).catch((error: unknown) => {
      logger.error(`Detection sweep failed: ${String(error)}`);
    });
  }, DETECTION_INTERVAL_MS);
  detectionTimer.unref();

  const app = await NestFactory.create<NestExpressApplication>(
    createAppModule({ config, health: new HealthService(db), auth, accounts, capabilities }),
  );

  // The ingress terminates TLS and sets the forwarded headers we read.
  app.set('trust proxy', true);
  app.enableShutdownHooks();

  const shutdown = async (): Promise<void> => {
    clearInterval(detectionTimer);
    await app.close();
    await db.destroy();
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());

  await app.listen(config.port, '0.0.0.0');
  logger.log(`Listening on ${config.port}`);
}

await bootstrap();
