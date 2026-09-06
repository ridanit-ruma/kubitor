import { describe, expect, it } from 'vitest';
import type { NodeSample } from '../kube/summary.js';
import { LiveCache, type LiveHostMetrics } from './live-cache.js';

const NOW = 1_756_800_000_000;

function sample(overrides: Partial<NodeSample> = {}): NodeSample {
  return {
    node: 'ken',
    at: NOW,
    cpuNanoCores: 500_000_000,
    memoryWorkingSetBytes: 2_147_483_648,
    fsUsedBytes: 20_000_000_000,
    fsCapacityBytes: 100_000_000_000,
    networkRxBytes: 1000,
    networkTxBytes: 2000,
    ...overrides,
  };
}

describe('LiveCache', () => {
  it('converts nanocores to millicores and a percentage of capacity', () => {
    const cache = new LiveCache();
    cache.setCapacity('ken', { cpuMilli: 4000, memoryBytes: 8_589_934_592 });

    cache.record(sample());

    const [metrics] = cache.current(NOW);
    expect(metrics?.cpuMilli).toBe(500);
    expect(metrics?.cpuPercent).toBe(12.5);
    expect(metrics?.memoryPercent).toBe(25);
  });

  it('computes filesystem usage against the capacity the kubelet reported', () => {
    const cache = new LiveCache();

    cache.record(sample());

    expect(cache.current(NOW)[0]?.fsPercent).toBe(20);
  });

  it('reports no percentage when capacity is unknown, rather than zero', () => {
    const cache = new LiveCache();

    cache.record(sample());

    expect(cache.current(NOW)[0]?.cpuPercent).toBeNull();
  });

  it('has no rate for the first reading and a rate for the second', () => {
    const cache = new LiveCache();

    cache.record(sample());
    expect(cache.current(NOW)[0]?.netRxBytesPerSecond).toBeNull();

    cache.record(sample({ at: NOW + 10_000, networkRxBytes: 11_000, networkTxBytes: 12_000 }));
    expect(cache.current(NOW + 10_000)?.[0]?.netRxBytesPerSecond).toBe(1000);
  });

  it('drops a counter reset rather than reporting negative traffic', () => {
    const cache = new LiveCache();

    cache.record(sample({ networkRxBytes: 999_999, networkTxBytes: 999_999 }));
    cache.record(sample({ at: NOW + 10_000, networkRxBytes: 5, networkTxBytes: 5 }));

    expect(cache.current(NOW + 10_000)[0]?.netRxBytesPerSecond).toBeNull();
  });

  /** Every pushed value must be able to say how old it is. */
  it('carries the instant the kubelet sampled, not the instant it was asked', () => {
    const cache = new LiveCache();

    cache.record(sample({ at: NOW - 12_000 }));

    expect(cache.current(NOW)[0]?.sampledAt).toBe(NOW - 12_000);
  });

  /**
   * A node whose kubelet stopped answering would otherwise keep its last value
   * on screen forever, which reads as healthy.
   */
  it('drops a node that has gone stale', () => {
    const cache = new LiveCache(60_000);

    cache.record(sample({ at: NOW - 61_000 }));

    expect(cache.current(NOW)).toEqual([]);
  });

  it('keeps a node that is merely a little behind', () => {
    const cache = new LiveCache(60_000);

    cache.record(sample({ at: NOW - 30_000 }));

    expect(cache.current(NOW)).toHaveLength(1);
  });

  it('holds one entry per node', () => {
    const cache = new LiveCache();

    cache.record(sample({ node: 'ken' }));
    cache.record(sample({ node: 'usher' }));
    cache.record(sample({ node: 'ken', cpuNanoCores: 1_000_000_000 }));

    const current = cache.current(NOW);
    expect(current).toHaveLength(2);
    expect(current.find((m) => m.node === 'ken')?.cpuMilli).toBe(1000);
  });

  it('forgets a node that left the cluster', () => {
    const cache = new LiveCache();
    cache.record(sample());

    cache.forget('ken');

    expect(cache.current(NOW)).toEqual([]);
  });

  it('passes through a gauge the kubelet did not report', () => {
    const cache = new LiveCache();

    cache.record(sample({ cpuNanoCores: null, memoryWorkingSetBytes: null }));

    const [metrics] = cache.current(NOW);
    expect(metrics?.cpuMilli).toBeNull();
    expect(metrics?.memoryBytes).toBeNull();
  });
});

describe('a machine with an agent and no kubelet', () => {
  const host = {
    sampledAt: NOW,
    cpuPercent: 12,
    memUsedBytes: 2_000_000_000,
    memTotalBytes: 8_000_000_000,
  } as unknown as LiveHostMetrics;

  /**
   * A host outside the cluster reports to the same endpoint and used to reach
   * no screen at all: the live view was built from kubelet readings, and it has
   * none.
   */
  it('appears in the current readings', () => {
    const cache = new LiveCache();
    cache.recordHost('buildbox', host);

    const current = cache.current(NOW);
    expect(current.map((metrics) => metrics.node)).toEqual(['buildbox']);
    expect(current[0]?.host).toBe(host);
  });

  /** Cluster figures are about the cluster; a machine outside it must not count. */
  it('is marked as not being a cluster node', () => {
    const cache = new LiveCache();
    cache.recordHost('buildbox', host);

    expect(cache.current(NOW)[0]?.clusterNode).toBe(false);
  });

  it('carries no kubelet figures rather than zeroes', () => {
    const cache = new LiveCache();
    cache.recordHost('buildbox', host);

    expect(cache.current(NOW)[0]).toMatchObject({
      cpuMilli: null,
      memoryBytes: null,
      capacityCpuMilli: null,
    });
  });

  it('goes away when its agent stops, like every other reading', () => {
    const cache = new LiveCache(60_000);
    cache.recordHost('buildbox', host);

    expect(cache.current(NOW + 61_000)).toEqual([]);
  });
});
