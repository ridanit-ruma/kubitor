import { type Kysely, sql } from 'kysely';
import type { NodeSample } from '../kube/summary.js';
import type { Database } from './schema.js';

export interface SeriesPoint {
  at: number;
  cpuMilli: number | null;
  memoryBytes: number | null;
  fsUsedBytes: number | null;
  fsCapacityBytes: number | null;
  netRxBytes: number | null;
  netTxBytes: number | null;
}

/** What the agent measured on the host, as a series rather than a snapshot. */
export interface HostSeriesPoint {
  at: number;
  cpuPercent: number | null;
  memUsedBytes: number | null;
  netRxBytesPerSecond: number | null;
  netTxBytesPerSecond: number | null;
}

/**
 * Time series for one node, from both sources that keep one.
 *
 * The kubelet's samples and the agent's readings measure different things —
 * containers against a declared capacity, versus the machine as the kernel sees
 * it — so they are kept apart and a screen picks one rather than splicing them.
 */
export class NodeSamplesRepo {
  readonly #db: Kysely<Database>;

  constructor(db: Kysely<Database>) {
    this.#db = db;
  }

  async record(sample: NodeSample): Promise<void> {
    await this.#db
      .insertInto('node_samples')
      .values({
        at: sample.at,
        node: sample.node,
        cpu_nano_cores: sample.cpuNanoCores,
        memory_working_set: sample.memoryWorkingSetBytes,
        fs_used: sample.fsUsedBytes,
        fs_capacity: sample.fsCapacityBytes,
        net_rx: sample.networkRxBytes,
        net_tx: sample.networkTxBytes,
      })
      .execute();
  }

  /**
   * Raw samples for one node over a window.
   *
   * Counters are returned as stored; converting them to rates is the caller's
   * job, because only the caller knows whether consecutive points are adjacent.
   */
  async series(node: string, since: number, until: number, limit = 5000): Promise<SeriesPoint[]> {
    const rows = await this.#db
      .selectFrom('node_samples')
      .selectAll()
      .where('node', '=', node)
      .where('at', '>=', since)
      .where('at', '<=', until)
      .orderBy('at', 'asc')
      .limit(limit)
      .execute();

    return rows.map((row) => ({
      at: Number(row.at),
      cpuMilli: row.cpu_nano_cores === null ? null : Number(row.cpu_nano_cores) / 1_000_000,
      memoryBytes: nullableNumber(row.memory_working_set),
      fsUsedBytes: nullableNumber(row.fs_used),
      fsCapacityBytes: nullableNumber(row.fs_capacity),
      netRxBytes: nullableNumber(row.net_rx),
      netTxBytes: nullableNumber(row.net_tx),
    }));
  }

  /**
   * The same window, reduced to one point per bucket.
   *
   * A seven-day window holds forty thousand samples. Drawing them into six
   * hundred pixels is noise, and cutting the query off at a row limit is worse
   * than noise: the rows kept are the oldest, so the chart quietly ends hours
   * before "now" while still claiming to cover the week.
   *
   * Gauges are averaged over the bucket and counters take the bucket's largest
   * value, which is the one standing at its newest sample — a rate computed
   * across two buckets is then the average rate over the gap between them.
   */
  async bucketed(
    node: string,
    since: number,
    until: number,
    widthMs: number,
  ): Promise<SeriesPoint[]> {
    const bucket = bucketOf('at', widthMs);

    const rows = await this.#db
      .selectFrom('node_samples')
      .select([
        sql<number>`max(at)`.as('at'),
        sql<number | null>`avg(cpu_nano_cores)`.as('cpu_nano_cores'),
        sql<number | null>`avg(memory_working_set)`.as('memory_working_set'),
        sql<number | null>`avg(fs_used)`.as('fs_used'),
        sql<number | null>`avg(fs_capacity)`.as('fs_capacity'),
        sql<number | null>`max(net_rx)`.as('net_rx'),
        sql<number | null>`max(net_tx)`.as('net_tx'),
      ])
      .where('node', '=', node)
      .where('at', '>=', since)
      .where('at', '<=', until)
      .groupBy(bucket)
      .orderBy(bucket, 'asc')
      .execute();

    return rows.map((row) => ({
      at: Number(row.at),
      cpuMilli: row.cpu_nano_cores === null ? null : Number(row.cpu_nano_cores) / 1_000_000,
      memoryBytes: nullableNumber(row.memory_working_set),
      fsUsedBytes: nullableNumber(row.fs_used),
      fsCapacityBytes: nullableNumber(row.fs_capacity),
      netRxBytes: nullableNumber(row.net_rx),
      netTxBytes: nullableNumber(row.net_tx),
    }));
  }

  /**
   * The agent's readings for one node, bucketed the same way.
   *
   * These are the figures the node screen shows above its charts: utilisation
   * measured from `/proc/stat`, memory as the kernel accounts it, and network
   * rates the agent computed itself once a second. A chart drawn from the
   * kubelet's numbers instead disagrees with the card sitting above it.
   *
   * `widthMs` of zero returns every stored reading.
   */
  async hostSeries(
    node: string,
    since: number,
    until: number,
    widthMs: number,
  ): Promise<HostSeriesPoint[]> {
    const base = this.#db
      .selectFrom('facet_host_hardware')
      .where('node', '=', node)
      .where('at', '>=', since)
      .where('at', '<=', until);

    if (widthMs <= 0) {
      const rows = await base
        .select([
          'at',
          'cpu_percent',
          'mem_used_bytes',
          'net_rx_bytes_per_second',
          'net_tx_bytes_per_second',
        ])
        .orderBy('at', 'asc')
        .limit(5000)
        .execute();

      return rows.map((row) => ({
        at: Number(row.at),
        cpuPercent: nullableNumber(row.cpu_percent),
        memUsedBytes: nullableNumber(row.mem_used_bytes),
        netRxBytesPerSecond: nullableNumber(row.net_rx_bytes_per_second),
        netTxBytesPerSecond: nullableNumber(row.net_tx_bytes_per_second),
      }));
    }

    const bucket = bucketOf('at', widthMs);
    const rows = await base
      .select([
        sql<number>`max(at)`.as('at'),
        sql<number | null>`avg(cpu_percent)`.as('cpu_percent'),
        sql<number | null>`avg(mem_used_bytes)`.as('mem_used_bytes'),
        sql<number | null>`avg(net_rx_bytes_per_second)`.as('net_rx_bytes_per_second'),
        sql<number | null>`avg(net_tx_bytes_per_second)`.as('net_tx_bytes_per_second'),
      ])
      .groupBy(bucket)
      .orderBy(bucket, 'asc')
      .execute();

    return rows.map((row) => ({
      at: Number(row.at),
      cpuPercent: nullableNumber(row.cpu_percent),
      memUsedBytes: nullableNumber(row.mem_used_bytes),
      netRxBytesPerSecond: nullableNumber(row.net_rx_bytes_per_second),
      netTxBytesPerSecond: nullableNumber(row.net_tx_bytes_per_second),
    }));
  }
}

/**
 * Fixed-width time buckets, in SQL both dialects read the same way.
 *
 * Integer division truncates on SQLite and on PostgreSQL alike, and epoch
 * milliseconds are positive, so truncation is the floor. The width is written
 * into the statement as a literal because a bound parameter in `GROUP BY` has
 * no type for PostgreSQL to infer.
 */
function bucketOf(column: 'at', widthMs: number) {
  return sql<number>`${sql.ref(column)} / ${sql.lit(Math.max(1, Math.round(widthMs)))}`;
}

function nullableNumber(value: number | string | null): number | null {
  return value === null ? null : Number(value);
}
