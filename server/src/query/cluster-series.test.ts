import { beforeAll, expect, it } from 'vitest';
import { migrateToLatest } from '../db/migrate.js';
import { describeEachDialect } from '../test/db-harness.js';
import { clusterTraffic } from './cluster-series.js';

const STEP_MS = 15_000;
/** Where the agent's readings live. */
const AGENT_START = 1_756_800_000_000;
/** A separate window, so a query for it sees no agent rows at all. */
const KUBELET_START = AGENT_START + 10 * 3_600_000;

const SAMPLES = 8;

describeEachDialect('clusterTraffic', (ctx) => {
  beforeAll(async () => {
    await migrateToLatest(ctx.db, ctx.kind);

    for (let index = 0; index < SAMPLES; index += 1) {
      for (const [node, scale] of [
        ['ken', 1],
        ['usher', 2],
      ] as const) {
        await ctx.db
          .insertInto('facet_host_hardware')
          .values({
            at: AGENT_START + index * STEP_MS,
            integration: 'host-agent',
            node,
            cpu_mhz: null,
            cpu_percent: null,
            gpu_mhz: null,
            mem_used_bytes: null,
            // A flat rate per node, so a sum is a number the test can predict.
            net_rx_bytes_per_second: 1000 * scale,
            net_tx_bytes_per_second: 500 * scale,
            temps: '{}',
            attrs: '{}',
          })
          .execute();

        await ctx.db
          .insertInto('node_samples')
          .values({
            at: KUBELET_START + index * STEP_MS,
            node,
            cpu_nano_cores: null,
            memory_working_set: null,
            fs_used: null,
            fs_capacity: null,
            // A counter climbing by a fixed amount every fifteen seconds.
            net_rx: index * 15_000 * scale,
            net_tx: index * 30_000 * scale,
          })
          .execute();
      }
    }
  });

  it('adds the nodes up at the storage interval', async () => {
    const points = await clusterTraffic(
      ctx.db,
      AGENT_START,
      AGENT_START + SAMPLES * STEP_MS,
      STEP_MS,
    );

    expect(points).toHaveLength(SAMPLES);
    expect(points[0]?.rxBytesPerSecond).toBe(3000);
    expect(points[0]?.txBytesPerSecond).toBe(1500);
  });

  /**
   * The mistake this guards against: a bucket four readings wide holds four
   * rows from each node, and adding those together reports a cluster moving
   * four times what it moves.
   */
  it('averages within a bucket before it adds the nodes up', async () => {
    const points = await clusterTraffic(
      ctx.db,
      AGENT_START,
      AGENT_START + SAMPLES * STEP_MS,
      4 * STEP_MS,
    );

    expect(points).toHaveLength(2);
    expect(points[0]?.rxBytesPerSecond).toBe(3000);
  });

  it('ends the window at the newest reading in it', async () => {
    const points = await clusterTraffic(
      ctx.db,
      AGENT_START,
      AGENT_START + SAMPLES * STEP_MS,
      4 * STEP_MS,
    );

    expect(points.at(-1)?.at).toBe(AGENT_START + (SAMPLES - 1) * STEP_MS);
  });

  /**
   * Counters cannot be added across machines that reset independently, so each
   * node's becomes a rate first. Here: 15 kB per 15 s is 1 kB/s on one node and
   * 2 kB/s on the other.
   */
  it('falls back to the kubelet counters where no agent reported', async () => {
    const points = await clusterTraffic(
      ctx.db,
      KUBELET_START,
      KUBELET_START + SAMPLES * STEP_MS,
      STEP_MS,
    );

    // The first bucket has no predecessor to subtract, so it carries no rate.
    expect(points[0]?.rxBytesPerSecond).toBeNull();
    expect(points[1]?.rxBytesPerSecond).toBeCloseTo(3000, 3);
    expect(points[1]?.txBytesPerSecond).toBeCloseTo(6000, 3);
  });

  it('reports nothing for a window neither source covers', async () => {
    expect(await clusterTraffic(ctx.db, 1, 2, STEP_MS)).toEqual([]);
  });
});
