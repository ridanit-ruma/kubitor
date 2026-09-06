import { describe, expect, it } from 'vitest';
import { Heartbeat } from './heartbeat.js';

function harness(options: { url?: string | null; status?: number } = {}) {
  const calls: { url: string; method: string }[] = [];
  let status = options.status ?? 200;

  const heartbeat = new Heartbeat({
    url: options.url === undefined ? 'https://hc-ping.com/abc' : options.url,
    fetch: async (input, init) => {
      calls.push({ url: String(input), method: init?.method ?? 'GET' });
      if (status === 0) throw new Error('network unreachable');
      return new Response('', { status });
    },
  });

  return {
    heartbeat,
    calls,
    answer(next: number) {
      status = next;
    },
  };
}

describe('Heartbeat', () => {
  it('pings the address it was given', async () => {
    const h = harness();

    expect(await h.heartbeat.beat()).toBe(true);
    expect(h.calls[0]).toEqual({ url: 'https://hc-ping.com/abc', method: 'GET' });
  });

  /** Off unless somebody names a receiver, which is the default. */
  it('does nothing at all with no address', async () => {
    const h = harness({ url: null });

    expect(h.heartbeat.enabled).toBe(false);
    expect(await h.heartbeat.beat()).toBe(false);
    expect(h.calls).toEqual([]);
  });

  /**
   * A failed ping means the outside world is unreachable, which is exactly
   * what the receiver is about to notice by itself. It must not become an
   * exception inside the server.
   */
  it('never throws when the receiver is unreachable', async () => {
    const h = harness();
    h.answer(0);

    await expect(h.heartbeat.beat()).resolves.toBe(false);
  });

  it('treats a refusal as a failed beat rather than a success', async () => {
    const h = harness({ status: 503 });

    expect(await h.heartbeat.beat()).toBe(false);
  });

  it('starts and stops cleanly, and beats once immediately', async () => {
    const h = harness();

    h.heartbeat.start();
    await new Promise((resolve) => setTimeout(resolve, 10));
    h.heartbeat.stop();

    expect(h.calls.length).toBeGreaterThanOrEqual(1);
  });
});
