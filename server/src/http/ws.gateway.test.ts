import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { signSessionToken } from '../auth/tokens.js';
import type { LiveNodeMetrics } from '../collect/live-cache.js';
import { LiveCache } from '../collect/live-cache.js';
import { frameMetrics, MAX_FRAME_BYTES } from '../collect/live-push.js';
import { createTestApp, seedAccount, type TestApp } from '../test/app-harness.js';
import { SESSION_COOKIE } from './cookies.js';
import { LiveGateway, PUSH_INTERVAL_MS } from './ws.gateway.js';

function metrics(node: string, sampledAt: number): LiveNodeMetrics {
  return {
    node,
    sampledAt,
    cpuMilli: 500,
    cpuPercent: 12.5,
    memoryBytes: 1024,
    memoryPercent: 10,
    fsUsedBytes: 1024,
    fsPercent: 5,
    netRxBytesPerSecond: 100,
    netTxBytesPerSecond: 200,
  };
}

describe('frameMetrics', () => {
  it('reports the newest sample instant so the client can show a real age', () => {
    const frame = frameMetrics([metrics('a', 1000), metrics('b', 5000)], 9000);

    const parsed = JSON.parse(frame.json);
    expect(parsed.sampledAt).toBe(5000);
    expect(parsed.generatedAt).toBe(9000);
    expect(frame.degraded).toBe(false);
  });

  it('reports no sample instant when there is nothing to report', () => {
    expect(JSON.parse(frameMetrics([], 9000).json).sampledAt).toBeNull();
  });

  /** One enormous cluster must not turn every socket into a firehose. */
  it('degrades an oversized frame to an invalidation signal', () => {
    const many = Array.from({ length: 5000 }, (_, index) =>
      metrics(`node-${index}-${'x'.repeat(40)}`, 1000),
    );

    const frame = frameMetrics(many, 9000);

    expect(frame.degraded).toBe(true);
    expect(frame.json.length).toBeLessThan(MAX_FRAME_BYTES);
    expect(JSON.parse(frame.json).signalOnly).toBe(true);
  });
});

describe('LiveGateway', () => {
  let harness: TestApp;
  let gateway: LiveGateway;
  let cache: LiveCache;
  let url: string;
  let cookie: string;

  beforeEach(async () => {
    harness = await createTestApp();
    await seedAccount(harness, 'admin');

    cache = new LiveCache();
    gateway = new LiveGateway({
      auth: harness.auth,
      cache,
      sessionSecret: harness.config.sessionSecret,
      logger: { warn: () => undefined },
      now: () => Date.now(),
    });

    await harness.app.listen(0);
    const server = harness.app.getHttpServer();
    gateway.attach(server);
    const address = server.address() as AddressInfo;
    url = `ws://127.0.0.1:${address.port}/api/ws`;

    const account = await harness.accounts.byUsername('admin');
    const session = await harness.sessions.create(account?.id as string, 3_600_000, Date.now());
    const token = await signSessionToken(
      session.id,
      harness.config.sessionSecret,
      session.expiresAt,
    );
    cookie = `${SESSION_COOKIE}=${token}`;
  });

  afterEach(async () => {
    await gateway.close();
    await harness.close();
  });

  function connect(header?: string): WebSocket {
    return new WebSocket(url, header ? { headers: { Cookie: header } } : {});
  }

  function firstMessage(socket: WebSocket): Promise<unknown> {
    return new Promise((resolve, reject) => {
      socket.once('message', (data) => resolve(JSON.parse(String(data))));
      socket.once('close', (code) => reject(new Error(`closed ${code}`)));
      socket.once('error', reject);
    });
  }

  function closeCode(socket: WebSocket): Promise<number> {
    return new Promise((resolve) => socket.once('close', (code) => resolve(code)));
  }

  it('pushes live metrics to an authenticated client', async () => {
    cache.record({
      node: 'ken',
      at: Date.now(),
      cpuNanoCores: 500_000_000,
      memoryWorkingSetBytes: 1024,
      fsUsedBytes: 1,
      fsCapacityBytes: 2,
      networkRxBytes: 1,
      networkTxBytes: 1,
    });

    const socket = connect(cookie);
    const frame = (await firstMessage(socket)) as { topic: string; nodes: unknown[] };

    expect(frame.topic).toBe('metrics.current');
    expect(frame.nodes).toHaveLength(1);
    socket.close();
  });

  it('refuses a connection with no session', async () => {
    expect(await closeCode(connect())).toBe(4401);
  });

  it('refuses a connection whose token is not ours', async () => {
    const socket = connect(`${SESSION_COOKIE}=not.a.token`);
    expect(await closeCode(socket)).toBe(4401);
  });

  /**
   * The rule that makes a data-carrying push safe. Checking only at connect
   * time would keep streaming cluster data to a session that has been ended.
   */
  it('stops pushing within one tick after the session is revoked', async () => {
    const socket = connect(cookie);
    await firstMessage(socket);

    await harness.db.deleteFrom('sessions').execute();

    const code = await Promise.race([
      closeCode(socket),
      new Promise<number>((resolve) => setTimeout(() => resolve(-1), PUSH_INTERVAL_MS * 3)),
    ]);

    expect(code).toBe(4401);
  });

  it('tracks its open connections', async () => {
    const socket = connect(cookie);
    await firstMessage(socket);

    expect(gateway.connectionCount).toBe(1);

    socket.close();
  });
});
