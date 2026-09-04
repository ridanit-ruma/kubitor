import { beforeAll, expect, it } from 'vitest';
import { describeEachDialect } from '../test/db-harness.js';
import { migrateToLatest } from './migrate.js';
import { NodeSamplesRepo } from './node-samples.repo.js';

const NOW = 1_756_800_000_000;
const NODE = 'calder';

/** Ten minutes of samples at the interval the collector actually stores. */
const SAMPLES = 40;
const STEP_MS = 15_000;
const START = NOW - SAMPLES * STEP_MS;

describeEachDialect('NodeSamplesRepo', (ctx) => {
  let repo: NodeSamplesRepo;

  beforeAll(async () => {
    await migrateToLatest(ctx.db, ctx.kind);
    repo = new NodeSamplesRepo(ctx.db);

    for (let index = 0; index < SAMPLES; index += 1) {
      await repo.record({
        at: START + index * STEP_MS,
        node: NODE,
        // A ramp, so an average over a bucket is a value the test can predict.
        cpuNanoCores: index * 1_000_000_000,
        memoryWorkingSetBytes: 1_000_000 + index,
        fsUsedBytes: null,
        fsCapacityBytes: null,
        // A counter climbing by a megabyte a sample.
        networkRxBytes: index * 1_048_576,
        networkTxBytes: index * 2_097_152,
      });

      await ctx.db
        .insertInto('facet_host_hardware')
        .values({
          at: START + index * STEP_MS,
          integration: 'host-agent',
          node: NODE,
          cpu_mhz: null,
          cpu_percent: index,
          gpu_mhz: null,
          mem_used_bytes: 2_000_000 + index,
          net_rx_bytes_per_second: index * 1024,
          net_tx_bytes_per_second: index * 2048,
          temps: '{}',
          attrs: '{}',
        })
        .execute();
    }
  });

  it('returns every stored sample when it is not asked to bucket', async () => {
    const points = await repo.series(NODE, START, NOW);
    expect(points).toHaveLength(SAMPLES);
    expect(points[0]?.at).toBe(START);
    expect(points.at(-1)?.at).toBe(START + (SAMPLES - 1) * STEP_MS);
  });

  it('averages gauges and keeps the newest counter in each bucket', async () => {
    // Four samples per bucket: 0-3, 4-7, and so on.
    const points = await repo.bucketed(NODE, START, NOW, 4 * STEP_MS);

    expect(points).toHaveLength(SAMPLES / 4);
    // The first bucket averages a CPU ramp of 0, 1, 2, 3 cores.
    expect(points[0]?.cpuMilli).toBeCloseTo(1500, 3);
    // Its counter is the value standing at the bucket's newest sample.
    expect(points[0]?.netRxBytes).toBe(3 * 1_048_576);
  });

  it('ends a bucketed window at the newest sample, not at a row limit', async () => {
    const points = await repo.bucketed(NODE, START, NOW, 4 * STEP_MS);
    expect(points.at(-1)?.at).toBe(START + (SAMPLES - 1) * STEP_MS);
  });

  it('reads the agent readings as a series of their own', async () => {
    const raw = await repo.hostSeries(NODE, START, NOW, 0);
    expect(raw).toHaveLength(SAMPLES);
    expect(raw[0]?.cpuPercent).toBe(0);
    expect(raw.at(-1)?.netRxBytesPerSecond).toBe((SAMPLES - 1) * 1024);

    const bucketed = await repo.hostSeries(NODE, START, NOW, 4 * STEP_MS);
    expect(bucketed).toHaveLength(SAMPLES / 4);
    // Rates are gauges here — the agent already divided by its own interval —
    // so a bucket averages them rather than taking the newest.
    expect(bucketed[0]?.netRxBytesPerSecond).toBeCloseTo(1.5 * 1024, 3);
  });

  it('reports nothing for a node that never reported', async () => {
    expect(await repo.bucketed('nowhere', START, NOW, 4 * STEP_MS)).toEqual([]);
    expect(await repo.hostSeries('nowhere', START, NOW, 4 * STEP_MS)).toEqual([]);
  });
});
