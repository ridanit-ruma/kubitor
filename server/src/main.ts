import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createAppModule } from './app.module.js';
import { loadConfig } from './config.js';
import { createDb } from './db/connect.js';
import { migrateToLatest } from './db/migrate.js';
import { HealthService } from './health.service.js';

async function bootstrap(): Promise<void> {
  const config = loadConfig(process.env);

  const db = createDb(config.db);
  await migrateToLatest(db, config.db.kind);

  const app = await NestFactory.create<NestExpressApplication>(
    createAppModule({ config, health: new HealthService(db) }),
  );

  // The ingress terminates TLS and sets the forwarded headers we read.
  app.set('trust proxy', true);

  const shutdown = async (): Promise<void> => {
    await app.close();
    await db.destroy();
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());

  await app.listen(config.port, '0.0.0.0');
}

await bootstrap();
