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
  /**
   * Totals, carried with every frame.
   *
   * A percentage without the capacity it was taken against is not a
   * measurement, and a screen that has to fetch capacity separately ends up
   * showing a used figure with no total beside it.
   */
  capacityCpuMilli: number | null;
  capacityMemoryBytes: number | null;
  fsCapacityBytes: number | null;
  /** Bytes per second, derived from the cumulative counters. */
  netRxBytesPerSecond: number | null;
  netTxBytesPerSecond: number | null;
  /** Present only where the agent is installed. */
  host?: LiveHostMetrics;
}

/**
 * What the agent adds, when there is one.
 *
 * Kept in its own object rather than flattened, so a screen can ask "is there
 * host data for this node" in one test instead of checking six fields for null.
 */
export interface LiveHostMetrics {
  /** When the agent took this reading. Its own clock, its own cadence. */
  sampledAt: number;
  cpuMhzAverage: number | null;
  cpuMhzMax: number | null;
  cpuCores: number | null;
  load1: number | null;
  memTotalBytes: number | null;
  memUsedBytes: number | null;
  memAvailableBytes: number | null;
  memPercent: number | null;
  swapTotalBytes: number | null;
  swapUsedBytes: number | null;
  gpuMhz: number | null;
  hottestCelsius: number | null;
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
  readonly #host = new Map<string, LiveHostMetrics>();
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
      capacityCpuMilli: capacity?.cpuMilli ?? null,
      capacityMemoryBytes: capacity?.memoryBytes ?? null,
      fsCapacityBytes: sample.fsCapacityBytes,
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
    return [...this.#latest.values()]
      .filter((metrics) => now - metrics.sampledAt <= this.#stalenessMs)
      .map((metrics) => {
        const host = this.#host.get(metrics.node);
        // Host readings go stale on their own schedule: an agent that stopped a
        // minute ago must not leave a frozen clock beside a live CPU figure.
        if (!host || now - host.sampledAt > this.#stalenessMs) return metrics;
        return { ...metrics, host };
      });
  }

  /** Nodes the agent is currently reporting for. */
  reportingHosts(now: number): string[] {
    return [...this.#host.entries()]
      .filter(([, host]) => now - host.sampledAt <= this.#stalenessMs)
      .map(([node]) => node);
  }

  recordHost(node: string, host: LiveHostMetrics): void {
    this.#host.set(node, host);
  }

  forget(node: string): void {
    this.#latest.delete(node);
    this.#previousCounters.delete(node);
    this.#capacity.delete(node);
    this.#host.delete(node);
  }
}
