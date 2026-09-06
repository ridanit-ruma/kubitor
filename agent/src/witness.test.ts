import { describe, expect, it } from 'vitest';
import { Witness, type WitnessReport } from './witness.js';

const START = 1_756_800_000_000;

function harness(options: { url?: string | null; afterMs?: number; repeatMs?: number } = {}) {
  const posted: WitnessReport[] = [];
  let now = START;
  let status = 200;

  const witness = new Witness({
    url: options.url === undefined ? 'https://hooks.example.com/kubitor-down' : options.url,
    host: 'calder',
    afterMs: options.afterMs ?? 300_000,
    repeatMs: options.repeatMs ?? 3_600_000,
    now: () => now,
    fetchImpl: async (_input, init) => {
      posted.push(JSON.parse(String(init?.body)) as WitnessReport);
      return new Response('', { status });
    },
  });

  return {
    witness,
    posted,
    advance(ms: number) {
      now += ms;
    },
    refuse(next: number) {
      status = next;
    },
  };
}

describe('Witness', () => {
  it('says nothing while the server is answering', async () => {
    const h = harness();

    h.witness.record(true);
    h.advance(10 * 60_000);
    h.witness.record(true);

    expect(await h.witness.check()).toBe(false);
    expect(h.posted).toEqual([]);
  });

  /**
   * A restart, a rollout and a brief blip all look like an unreachable server
   * for a few seconds. A witness that fired on those would be the noisiest
   * thing in the estate.
   */
  it('waits out a short outage without saying anything', async () => {
    const h = harness({ afterMs: 300_000 });

    h.witness.record(true);
    h.advance(60_000);
    h.witness.record(false);

    expect(await h.witness.check()).toBe(false);
    expect(h.posted).toEqual([]);
  });

  it('shouts once the server has been gone long enough', async () => {
    const h = harness({ afterMs: 300_000 });

    h.witness.record(true);
    h.advance(301_000);
    h.witness.record(false);

    expect(await h.witness.check()).toBe(true);
    expect(h.posted[0]).toMatchObject({ kind: 'server-unreachable', host: 'calder' });
    expect(h.posted[0]?.unreachableForMs).toBeGreaterThanOrEqual(300_000);
  });

  /**
   * Names the observer, which is what makes four messages from four nodes
   * information rather than noise: one node means that node's network, and
   * every node means the server.
   */
  it('names the machine that observed it', async () => {
    const h = harness({ afterMs: 1000 });

    h.advance(2000);
    await h.witness.check();

    expect(h.posted[0]?.host).toBe('calder');
  });

  it('does not repeat itself every second while the outage continues', async () => {
    const h = harness({ afterMs: 1000, repeatMs: 3_600_000 });

    h.advance(2000);
    expect(await h.witness.check()).toBe(true);

    h.advance(60_000);
    expect(await h.witness.check()).toBe(false);

    h.advance(3_600_000);
    expect(await h.witness.check()).toBe(true);
    expect(h.posted).toHaveLength(2);
  });

  /** And says so again next time if it comes back and goes away again. */
  it('starts over once contact is restored', async () => {
    const h = harness({ afterMs: 1000, repeatMs: 3_600_000 });

    h.advance(2000);
    await h.witness.check();

    h.witness.record(true);
    expect(await h.witness.check()).toBe(false);

    h.advance(2000);
    h.witness.record(false);
    expect(await h.witness.check()).toBe(true);
    expect(h.posted).toHaveLength(2);
  });

  /** Off unless an address is given, which is the default. */
  it('stays quiet with no address configured', async () => {
    const h = harness({ url: null, afterMs: 1000 });

    h.advance(2000);

    expect(h.witness.enabled).toBe(false);
    expect(await h.witness.check()).toBe(false);
    expect(h.posted).toEqual([]);
  });

  /**
   * An agent that can reach neither the server nor the witness address has
   * nothing left to try, and retrying hard would only add load to whatever is
   * already broken.
   */
  it('gives up quietly when the witness address is refusing too', async () => {
    const h = harness({ afterMs: 1000 });
    h.refuse(500);

    h.advance(2000);

    expect(await h.witness.check()).toBe(false);
  });

  it('reports having never reached the server at all', async () => {
    const h = harness({ afterMs: 1000 });

    h.advance(2000);
    await h.witness.check();

    expect(h.posted[0]?.lastContactAt).toBeNull();
  });
});
