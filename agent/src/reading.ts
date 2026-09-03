import { readCpu } from './cpufreq.js';
import { type DiskReading, readDisks } from './disks.js';
import { readGpus } from './gpu.js';
import { readHwmonTemperatures } from './hwmon.js';
import { readMemory } from './meminfo.js';

/** One complete picture of a host, as the server receives it. */
export interface HostReading extends Record<string, unknown> {
  at: number;
  node: string;
  cpu_model: string | null;
  cpu_cores: number | null;
  cpu_mhz_avg: number | null;
  cpu_mhz_max: number | null;
  load1: number | null;
  load5: number | null;
  load15: number | null;
  mem_total_bytes: number | null;
  mem_available_bytes: number | null;
  mem_used_bytes: number | null;
  mem_cached_bytes: number | null;
  swap_total_bytes: number | null;
  swap_used_bytes: number | null;
  gpu_mhz: number | null;
  gpus: Record<string, unknown>[];
  disks: Record<string, unknown>[];
  temps: Record<string, number>;
}

/**
 * Collects a host reading, reusing the disk list between calls.
 *
 * Everything here is read once a second. Mount points are the exception: they
 * change on the timescale of an administrator, not a dashboard, and `statfs`
 * on every mount every second is real I/O for a number that has not moved.
 */
export function createHostCollector(node: string, diskRefreshMs = 15_000) {
  let disks: DiskReading[] = [];
  let disksReadAt = 0;

  return async function collect(now: number): Promise<HostReading> {
    if (now - disksReadAt >= diskRefreshMs) {
      disks = await readDisks();
      disksReadAt = now;
    }

    const [cpu, memory, gpus, temps] = await Promise.all([
      readCpu(),
      readMemory(),
      readGpus(),
      readHwmonTemperatures(),
    ]);

    // The busiest card is the one a single figure should describe.
    const gpuMhz = gpus.reduce<number | null>(
      (highest, gpu) =>
        gpu.mhzCur === null
          ? highest
          : highest === null
            ? gpu.mhzCur
            : Math.max(highest, gpu.mhzCur),
      null,
    );

    return {
      at: now,
      node,
      cpu_model: cpu.model,
      cpu_cores: cpu.cores,
      cpu_mhz_avg: cpu.mhzAverage,
      cpu_mhz_max: cpu.mhzMax,
      load1: cpu.load1,
      load5: cpu.load5,
      load15: cpu.load15,
      mem_total_bytes: memory.totalBytes,
      mem_available_bytes: memory.availableBytes,
      mem_used_bytes: memory.usedBytes,
      mem_cached_bytes: memory.cachedBytes,
      swap_total_bytes: memory.swapTotalBytes,
      swap_used_bytes: memory.swapUsedBytes,
      gpu_mhz: gpuMhz,
      gpus: gpus.map((gpu) => ({ ...gpu })),
      disks: disks.map((disk) => ({ ...disk })),
      temps,
    };
  };
}
