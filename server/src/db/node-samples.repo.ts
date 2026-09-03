import type { Kysely } from 'kysely';
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
}

function nullableNumber(value: number | null): number | null {
  return value === null ? null : Number(value);
}
