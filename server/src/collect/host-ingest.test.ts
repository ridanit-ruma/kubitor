import { beforeEach, describe, expect, it } from 'vitest';
import { migrateToLatest } from '../db/migrate.js';
import { IngestPipeline } from '../plugins/ingest.js';
import { describeEachDialect } from '../test/db-harness.js';
import { HostIngest, type HostReading, toLiveMetrics } from './host-ingest.js';
import { LiveCache } from './live-cache.js';

const NOW = 1_756_800_000_000;

function reading(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    at: NOW,
    node: 'ignored-by-the-server',
    cpu_model: 'Test CPU',
    cpu_cores: 12,
    cpu_percent: 12.5,
    cpu_mhz_avg: 2300,
    cpu_mhz_max: 4400,
    load1: 0.5,
    load5: 0.4,
    load15: 0.3,
    mem_total_bytes: 24_955_392_000,
    mem_available_bytes: 22_000_000_000,
    mem_used_bytes: 2_955_392_000,
    mem_cached_bytes: 8_000_000_000,
    swap_total_bytes: 0,
    swap_used_bytes: 0,
    gpu_mhz: 1100,
    net_rx_bytes_per_second: 109_345,
    net_tx_bytes_per_second: 263_545,
    gpus: [{ card: 'card1', driver: 'i915', mhzCur: 1100, mhzMax: 1100 }],
    disks: [
      { mount: '/', device: '/dev/nvme0n1p2', fsType: 'ext4', totalBytes: 100, usedBytes: 10 },
    ],
    temps: { 'coretemp.Package id 0': 44.5 },
    ...overrides,
  };
}

describeEachDialect('HostIngest', (ctx) => {
  let cache: LiveCache;
  let ingest: HostIngest;

  beforeEach(async () => {
    await migrateToLatest(ctx.db, ctx.kind);
    await ctx.db.deleteFrom('facet_host_hardware').execute();
    await ctx.db.deleteFrom('facet_host_resources').execute();

    cache = new LiveCache();
    ingest = new HostIngest({
      cache,
      pipeline: new IngestPipeline(ctx.db, ctx.sqlHelper),
      persistIntervalMs: 15_000,
    });
  });

  it('takes the node from the caller, never from the row', async () => {
    await ingest.accept('calder', [reading({ node: 'somebody-else' })], NOW);

    expect(cache.reportingHosts(NOW)).toEqual(['calder']);
  });

  it('updates the live cache on every reading', async () => {
    cache.setCapacity('calder', { cpuMilli: 12_000, memoryBytes: 24_955_392_000 });
    cache.record({
      node: 'calder',
      at: NOW,
      cpuNanoCores: 1_000_000,
      memoryWorkingSetBytes: 1024,
      fsUsedBytes: 1024,
      fsCapacityBytes: 2048,
      networkRxBytes: null,
      networkTxBytes: null,
    });

    await ingest.accept('calder', [reading({ cpu_mhz_avg: 1000 })], NOW);
    expect(cache.current(NOW)[0]?.host?.cpuMhzAverage).toBe(1000);

    await ingest.accept('calder', [reading({ at: NOW + 1000, cpu_mhz_avg: 3900 })], NOW + 1000);
    expect(cache.current(NOW)[0]?.host?.cpuMhzAverage).toBe(3900);
  });

  /**
   * The rule this class exists for. The agent reports once a second; writing
   * every one of those is how a SQLite file on a single PVC gets destroyed.
   */
  it('writes at the storage cadence, not the reporting cadence', async () => {
    const report = async (second: number): Promise<void> => {
      const at = NOW + second * 1000;
      await ingest.accept('calder', [reading({ at })], at);
    };

    // Fifteen reports across fourteen seconds: the first is written, and
    // nothing else is, because the interval has not elapsed.
    for (let second = 0; second <= 14; second += 1) await report(second);
    expect(await hardwareRows()).toHaveLength(1);

    // The fifteenth second crosses the boundary, and exactly one more lands.
    await report(15);
    await report(16);
    expect(await hardwareRows()).toHaveLength(2);
  });

  async function hardwareRows() {
    return await ctx.db.selectFrom('facet_host_hardware').selectAll().execute();
  }

  it('keeps every node in the resources snapshot', async () => {
    await ingest.accept('calder', [reading()], NOW);
    await ingest.accept('decker', [reading({ at: NOW + 20_000 })], NOW + 20_000);

    const rows = await ctx.db.selectFrom('facet_host_resources').selectAll().execute();
    expect(rows.map((row) => row.node).sort()).toEqual(['calder', 'decker']);
  });

  /**
   * Every field the agent sends has to be declared on the facet as well as on
   * the ingest schema. One that is declared on only one of them is dropped in
   * silence — the write succeeds, the column stays null, and nothing complains.
   */
  it('keeps every measurement the agent sent, not just the ones it parsed', async () => {
    await ingest.accept('calder', [reading()], NOW);

    const row = await ctx.db
      .selectFrom('facet_host_hardware')
      .selectAll()
      .executeTakeFirstOrThrow();

    expect(Number(row.cpu_mhz)).toBe(2300);
    expect(Number(row.cpu_percent)).toBe(12.5);
    expect(Number(row.mem_used_bytes)).toBe(2_955_392_000);
    expect(Number(row.net_rx_bytes_per_second)).toBe(109_345);
    expect(Number(row.net_tx_bytes_per_second)).toBe(263_545);
  });

  it('stores the disks and GPUs it was given', async () => {
    await ingest.accept('calder', [reading()], NOW);

    const row = await ctx.db
      .selectFrom('facet_host_resources')
      .selectAll()
      .executeTakeFirstOrThrow();

    const disks = ctx.sqlHelper.decodeJson(row.disks) as { mount: string }[];
    const gpus = ctx.sqlHelper.decodeJson(row.gpus) as { driver: string }[];
    expect(disks[0]?.mount).toBe('/');
    expect(gpus[0]?.driver).toBe('i915');
  });

  it('drops a malformed reading without losing the batch', async () => {
    const accepted = await ingest.accept('calder', [{ at: 'not a number' }, reading()], NOW);

    expect(accepted).toBe(1);
    expect(cache.reportingHosts(NOW)).toEqual(['calder']);
  });

  /**
   * Detection decides whether the agent's screens exist and sweeps every five
   * minutes, so without this the Hardware screen is missing for up to five
   * minutes after every server restart.
   */
  it('announces a node the first time it reports, and only then', async () => {
    const announced: string[] = [];
    ingest.onFirstReport((node) => announced.push(node));

    await ingest.accept('calder', [reading()], NOW);
    await ingest.accept('calder', [reading({ at: NOW + 1000 })], NOW + 1000);
    await ingest.accept('decker', [reading({ at: NOW + 2000 })], NOW + 2000);

    expect(announced).toEqual(['calder', 'decker']);
  });

  it('accepts a machine with no swap, no GPU and no readable sensor', async () => {
    const bare = reading({ swap_total_bytes: 0, gpus: [], disks: [], temps: {}, gpu_mhz: null });
    const accepted = await ingest.accept('calder', [bare], NOW);

    expect(accepted).toBe(1);
    expect(cache.current(NOW)).toBeDefined();
  });
});

describe('toLiveMetrics', () => {
  it('computes memory pressure against the host total', () => {
    const metrics = toLiveMetrics(
      { ...reading(), mem_total_bytes: 1000, mem_used_bytes: 250 } as unknown as HostReading,
      NOW,
    );

    expect(metrics.memPercent).toBe(25);
  });

  it('reports the hottest sensor', () => {
    const metrics = toLiveMetrics(
      { ...reading(), temps: { a: 40, b: 71.5, c: 55 } } as unknown as HostReading,
      NOW,
    );

    expect(metrics.hottestCelsius).toBe(71.5);
  });

  it('reports no temperature rather than zero when nothing could be read', () => {
    const metrics = toLiveMetrics({ ...reading(), temps: {} } as unknown as HostReading, NOW);
    expect(metrics.hottestCelsius).toBeNull();
  });

  it('never dates a reading into the future', () => {
    // An agent whose clock runs fast would otherwise show a negative age, and
    // the whole point of `sampledAt` is that the age it produces is honest.
    const metrics = toLiveMetrics(
      { ...reading(), at: NOW + 60_000 } as unknown as HostReading,
      NOW,
    );
    expect(metrics.sampledAt).toBe(NOW);
  });
});
