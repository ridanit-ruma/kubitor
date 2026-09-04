import { z } from 'zod';
import type { IngestPipeline } from '../plugins/ingest.js';
import type { LiveCache, LiveHostDetail, LiveHostMetrics } from './live-cache.js';

/**
 * What the agent sends, once a second.
 *
 * Deliberately permissive about missing fields: a machine with no swap, no GPU
 * and no readable sensors is a normal machine, and every one of those absences
 * must produce a null rather than a dropped reading.
 */
export const hostReadingSchema = z.object({
  at: z.number().int(),
  node: z.string().max(253),
  cpu_model: z.string().max(1024).nullish(),
  cpu_cores: z.number().int().min(0).max(4096).nullish(),
  cpu_percent: z.number().min(0).max(100).nullish(),
  cpu_mhz_avg: z.number().int().min(0).nullish(),
  cpu_mhz_max: z.number().int().min(0).nullish(),
  load1: z.number().min(0).nullish(),
  load5: z.number().min(0).nullish(),
  load15: z.number().min(0).nullish(),
  mem_total_bytes: z.number().int().min(0).nullish(),
  mem_available_bytes: z.number().int().min(0).nullish(),
  mem_used_bytes: z.number().int().min(0).nullish(),
  mem_cached_bytes: z.number().int().min(0).nullish(),
  swap_total_bytes: z.number().int().min(0).nullish(),
  swap_used_bytes: z.number().int().min(0).nullish(),
  gpu_mhz: z.number().int().min(0).nullish(),
  net_rx_bytes_per_second: z.number().min(0).nullish(),
  net_tx_bytes_per_second: z.number().min(0).nullish(),
  cpu: z.record(z.string(), z.unknown()).nullish(),
  memory_modules: z.array(z.record(z.string(), z.unknown())).max(64).default([]),
  memory_slots: z.number().int().min(0).max(64).nullish(),
  sensors: z.array(z.record(z.string(), z.unknown())).max(256).default([]),
  nics: z.array(z.record(z.string(), z.unknown())).max(64).default([]),
  block_devices: z.array(z.record(z.string(), z.unknown())).max(64).default([]),
  gpus: z.array(z.record(z.string(), z.unknown())).max(16).default([]),
  disks: z.array(z.record(z.string(), z.unknown())).max(64).default([]),
  temps: z.record(z.string(), z.number()).default({}),
});

export type HostReading = z.infer<typeof hostReadingSchema>;

/** How often a host reading reaches the database, whatever the report rate. */
export const HOST_PERSIST_INTERVAL_MS = 15_000;

export interface HostIngestDeps {
  cache: LiveCache;
  pipeline: IngestPipeline;
  persistIntervalMs?: number;
}

/**
 * Where the agent's once-a-second stream meets the database's patience.
 *
 * Every reading updates the live cache, so the dashboard moves at the rate the
 * agent reports. Only one reading in fifteen seconds is written down. Pushing at
 * the storage cadence makes the screen look dead; storing at the push cadence
 * destroys the SQLite file — this is the seam that keeps them apart.
 *
 * Resource snapshots are held per node and written as one snapshot for all
 * nodes, because a state facet replaces everything its integration reported: a
 * per-node write would delete every other node's row.
 */
export class HostIngest {
  readonly #deps: HostIngestDeps;
  readonly #latest = new Map<string, HostReading>();
  readonly #persistIntervalMs: number;
  #lastPersistedAt = 0;
  #onFirstReport: ((node: string) => void) | undefined;

  constructor(deps: HostIngestDeps) {
    this.#deps = deps;
    this.#persistIntervalMs = deps.persistIntervalMs ?? HOST_PERSIST_INTERVAL_MS;
  }

  /**
   * Called when a node reports for the first time.
   *
   * Detection decides whether the agent's screens exist, and it sweeps every
   * five minutes. Without this the Hardware screen disappears for up to five
   * minutes after every server restart, while agents that are plainly running
   * are reported as absent. Registered after construction because the detection
   * service needs the module list this ingest feeds.
   */
  onFirstReport(listener: (node: string) => void): void {
    this.#onFirstReport = listener;
  }

  /** Accepts one node's readings. Returns how many were usable. */
  async accept(node: string, rows: readonly unknown[], now: number): Promise<number> {
    let accepted = 0;

    for (const row of rows) {
      // The node is taken from the caller's identity, never from the row: an
      // agent must not be able to report on another machine's behalf.
      const parsed = hostReadingSchema.safeParse({ ...(row as object), node });
      if (!parsed.success) continue;

      accepted += 1;
      const firstReport = !this.#latest.has(node);
      this.#latest.set(node, parsed.data);
      this.#deps.cache.recordHost(node, toLiveMetrics(parsed.data, now), toLiveDetail(parsed.data));
      if (firstReport) this.#onFirstReport?.(node);
    }

    if (accepted > 0) await this.#maybePersist(now);
    return accepted;
  }

  async #maybePersist(now: number): Promise<void> {
    if (now - this.#lastPersistedAt < this.#persistIntervalMs) return;
    this.#lastPersistedAt = now;

    const readings = [...this.#latest.values()];

    await this.#deps.pipeline.ingest(
      'host-agent',
      'host.hardware',
      readings.map((reading) => ({
        at: reading.at,
        node: reading.node,
        cpu_mhz: reading.cpu_mhz_avg ?? null,
        cpu_percent: reading.cpu_percent ?? null,
        gpu_mhz: reading.gpu_mhz ?? null,
        mem_used_bytes: reading.mem_used_bytes ?? null,
        net_rx_bytes_per_second: reading.net_rx_bytes_per_second ?? null,
        net_tx_bytes_per_second: reading.net_tx_bytes_per_second ?? null,
        temps: reading.temps,
        attrs: {},
      })),
      now,
    );

    await this.#deps.pipeline.ingest(
      'host-agent',
      'host.resources',
      readings.map((reading) => ({
        observed_at: reading.at,
        node: reading.node,
        cpu_model: reading.cpu_model ?? null,
        cpu_cores: reading.cpu_cores ?? null,
        cpu_percent: reading.cpu_percent ?? null,
        cpu_mhz_avg: reading.cpu_mhz_avg ?? null,
        cpu_mhz_max: reading.cpu_mhz_max ?? null,
        load1: reading.load1 ?? null,
        load5: reading.load5 ?? null,
        load15: reading.load15 ?? null,
        mem_total_bytes: reading.mem_total_bytes ?? null,
        mem_available_bytes: reading.mem_available_bytes ?? null,
        mem_used_bytes: reading.mem_used_bytes ?? null,
        mem_cached_bytes: reading.mem_cached_bytes ?? null,
        swap_total_bytes: reading.swap_total_bytes ?? null,
        swap_used_bytes: reading.swap_used_bytes ?? null,
        gpus: reading.gpus,
        disks: reading.disks,
        cpu: reading.cpu ?? null,
        memory_modules: reading.memory_modules,
        memory_slots: reading.memory_slots ?? null,
        sensors: reading.sensors,
        nics: reading.nics,
        block_devices: reading.block_devices,
        attrs: {},
      })),
      now,
    );
  }
}

export function toLiveMetrics(reading: HostReading, now: number): LiveHostMetrics {
  const total = reading.mem_total_bytes ?? null;
  const used = reading.mem_used_bytes ?? null;

  const celsius = Object.values(reading.temps);

  return {
    // The agent's own clock decides how old this is, but a clock that is ahead
    // of ours would make the reading look like it arrives from the future.
    sampledAt: Math.min(reading.at, now),
    cpuPercent: reading.cpu_percent ?? null,
    cpuMhzAverage: reading.cpu_mhz_avg ?? null,
    cpuMhzMax: reading.cpu_mhz_max ?? null,
    cpuCores: reading.cpu_cores ?? null,
    load1: reading.load1 ?? null,
    memTotalBytes: total,
    memUsedBytes: used,
    memAvailableBytes: reading.mem_available_bytes ?? null,
    memPercent: total !== null && used !== null && total > 0 ? (used / total) * 100 : null,
    swapTotalBytes: reading.swap_total_bytes ?? null,
    swapUsedBytes: reading.swap_used_bytes ?? null,
    gpuMhz: reading.gpu_mhz ?? null,
    netRxBytesPerSecond: reading.net_rx_bytes_per_second ?? null,
    netTxBytesPerSecond: reading.net_tx_bytes_per_second ?? null,
    hottestCelsius: celsius.length === 0 ? null : Math.max(...celsius),
  };
}

/**
 * The per-device half of a reading, for the node screen.
 *
 * Passed through as the agent sent it: this is the same shape the stored
 * snapshot carries, so a screen reads one type whichever source answered.
 */
export function toLiveDetail(reading: HostReading): LiveHostDetail {
  return {
    sampledAt: reading.at,
    sensors: reading.sensors,
    nics: reading.nics,
    blockDevices: reading.block_devices,
    gpus: reading.gpus,
  };
}
