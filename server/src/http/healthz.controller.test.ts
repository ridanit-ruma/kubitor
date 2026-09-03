import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAppModule } from '../app.module.js';
import type { Config } from '../config.js';
import type { HealthService } from '../health.service.js';

const config = {
  port: 3001,
  db: { kind: 'sqlite', sqlitePath: ':memory:' },
  sessionSecret: 'x'.repeat(32),
  sessionTtlMs: 3_600_000,
  trustedProxyHeader: 'cf-connecting-ip',
  cookieSecure: true,
} as Config;

let app: INestApplication;
let reachable = true;

beforeAll(async () => {
  const health = { databaseReachable: async () => reachable } as HealthService;
  const auth = {} as never;
  const accounts = {} as never;

  const moduleRef = await Test.createTestingModule({
    imports: [createAppModule({ config, health, auth, accounts })],
  }).compile();

  app = moduleRef.createNestApplication();
  await app.init();
});

afterAll(async () => {
  await app.close();
});

describe('health endpoints', () => {
  it('answers liveness without a session', async () => {
    const response = await request(app.getHttpServer()).get('/api/healthz');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
  });

  it('reports ready while the database answers', async () => {
    reachable = true;
    const response = await request(app.getHttpServer()).get('/api/readyz');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok', database: true });
  });

  it('reports degraded when the database does not answer', async () => {
    reachable = false;
    const response = await request(app.getHttpServer()).get('/api/readyz');

    expect(response.body).toEqual({ status: 'degraded', database: false });
  });
});
