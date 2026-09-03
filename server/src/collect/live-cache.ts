import { counterRate, percentOf } from '../kube/rates.js';
import type { NodeSample } from '../kube/summary.js';

export interface LiveNodeMetrics {
  node: string;
  /** When the kubelet took this reading — not when it was pushed. */
  sampledAt: number;
  cpuMilli: number | null;
  cpuPercent: number | null;
  memoryBytes: number | null;
  memoryPercent: number | null;
  fsUsedBytes: number | null;
  fsPercent: number | null;
  /** Bytes per second, derived from the cumulative counters. */
  netRxBytesPerSecond: number | null;
  netTxBytesPerSecond: number | null;
}

export interface NodeCapacity {
  cpuMilli: number;
  memoryBytes: number;
}

/**
 * The newest reading per node, held in memory.
 *
 * This is what the WebSocket pushes every second. Persistence runs on its own,
 * much slower schedule: pushing at the storage cadence would make the dashboard
 * feel dead, and storing at the push cadence would destroy the database.
 *
 * Every entry carries `sampledAt` so the interface can say how old the number
 * really is rather than implying it is a second old.
 */
export class LiveCache {
  readonly #latest = new Map<string, LiveNodeMetrics>();
  readonly #previousCounters = new Map<string, { at: number; rx: number; tx: number }>();
  readonly #capacity = new Map<string, NodeCapacity>();
  /** Readings older than this are dropped: a dead node must not look alive. */
  readonly #stalenessMs: number;

  constructor(stalenessMs = 60_000) {
    this.#stalenessMs = stalenessMs;
  }

  setCapacity(node: string, capacity: NodeCapacity): void {
    this.#capacity.set(node, capacity);
  }

  record(sample: NodeSample): void {
    const capacity = this.#capacity.get(sample.node);
    const previous = this.#previousCounters.get(sample.node);

    const rx =
      sample.networkRxBytes === null
        ? null
        : counterRate(previous ? { at: previous.at, value: previous.rx } : undefined, {
            at: sample.at,
            value: sample.networkRxBytes,
          });
    const tx =
      sample.networkTxBytes === null
        ? null
        : counterRate(previous ? { at: previous.at, value: previous.tx } : undefined, {
            at: sample.at,
            value: sample.networkTxBytes,
          });

    if (sample.networkRxBytes !== null && sample.networkTxBytes !== null) {
      this.#previousCounters.set(sample.node, {
        at: sample.at,
        rx: sample.networkRxBytes,
        tx: sample.networkTxBytes,
      });
    }

    const cpuMilli = sample.cpuNanoCores === null ? null : sample.cpuNanoCores / 1_000_000;

    this.#latest.set(sample.node, {
      node: sample.node,
      sampledAt: sample.at,
      cpuMilli,
      cpuPercent: percentOf(cpuMilli, capacity?.cpuMilli ?? null),
      memoryBytes: sample.memoryWorkingSetBytes,
      memoryPercent: percentOf(sample.memoryWorkingSetBytes, capacity?.memoryBytes ?? null),
      fsUsedBytes: sample.fsUsedBytes,
      fsPercent: percentOf(sample.fsUsedBytes, sample.fsCapacityBytes),
      netRxBytesPerSecond: rx,
      netTxBytesPerSecond: tx,
    });
  }

  /**
   * Current readings, with stale nodes dropped.
   *
   * A node whose kubelet stopped answering keeps its last value forever
   * otherwise, and a frozen number that looks live is worse than a gap.
   */
  current(now: number): LiveNodeMetrics[] {
    return [...this.#latest.values()].filter(
      (metrics) => now - metrics.sampledAt <= this.#stalenessMs,
    );
  }

  forget(node: string): void {
    this.#latest.delete(node);
    this.#previousCounters.delete(node);
    this.#capacity.delete(node);
  }
}
