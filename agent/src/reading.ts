import { type BlockDevice, createBlockMeter } from './blockdev.js';
import { readCpu } from './cpufreq.js';
import { createCpuMeter } from './cpustat.js';
import { type DiskReading, readDisks } from './disks.js';
import { readGpus } from './gpu.js';
import {
  type CpuDetail,
  type MemoryInventory,
  readCpuDetail,
  readMemoryModules,
} from './hwinfo.js';
import { readHwmonTemperatures, type SensorReading, sensorRecord } from './hwmon.js';
import { readMemory } from './meminfo.js';
import { createNetworkMeter } from './netdev.js';

/** Null unless at least one interface answered; a sum of nothing is not zero. */
function sumRates(values: readonly (number | null)[]): number | null {
  const usable = values.filter((value): value is number => value !== null);
  return usable.length === 0 ? null : usable.reduce((total, value) => total + value, 0);
}

/** One complete picture of a host, as the server receives it. */
export interface HostReading extends Record<string, unknown> {
  at: number;
  node: string;
  cpu_model: string | null;
  cpu_cores: number | null;
  /** How busy the machine was over the last interval, 0-100. */
  cpu_percent: number | null;
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
  /** Summed across physical interfaces, measured here once a second. */
  net_rx_bytes_per_second: number | null;
  net_tx_bytes_per_second: number | null;
  gpus: Record<string, unknown>[];
  disks: Record<string, unknown>[];
  /** What the machine is, as opposed to what it is doing. */
  cpu: Record<string, unknown> | null;
  memory_modules: Record<string, unknown>[];
  /** Slots the controller knows about, so "8 of 8" can be said. */
  memory_slots: number | null;
  nics: Record<string, unknown>[];
  block_devices: Record<string, unknown>[];
  /** Flat, for history. Keyed by device so two drives do not collide. */
  temps: Record<string, number>;
  /** The same readings with the device they belong to, for the screens. */
  sensors: Record<string, unknown>[];
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
  let inventory: { cpu: CpuDetail; memory: MemoryInventory } | null = null;

  const cpuBusy = createCpuMeter();
  const network = createNetworkMeter();
  const blockDevices = createBlockMeter();

  return async function collect(now: number): Promise<HostReading> {
    if (now - disksReadAt >= diskRefreshMs) {
      disks = await readDisks();
      disksReadAt = now;
    }

    // What the machine is does not change while it is running, so it is read
    // once and kept. What it is doing is read every time.
    if (inventory === null) {
      inventory = { cpu: await readCpuDetail(), memory: await readMemoryModules() };
    }
    const machine = inventory;

    const [cpu, cpuPercent, memory, gpus, sensors, nics, blocks] = await Promise.all([
      readCpu(),
      cpuBusy(),
      readMemory(),
      readGpus(),
      readHwmonTemperatures(),
      network(now),
      blockDevices(now),
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
      cpu_percent: cpuPercent,
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
      net_rx_bytes_per_second: sumRates(nics.map((nic) => nic.rxBytesPerSecond)),
      net_tx_bytes_per_second: sumRates(nics.map((nic) => nic.txBytesPerSecond)),
      gpus: gpus.map((gpu) => ({ ...gpu })),
      disks: disks.map((disk) => ({ ...disk })),
      cpu: { ...machine.cpu },
      memory_modules: machine.memory.modules.map((module) => ({ ...module })),
      memory_slots: machine.memory.slots,
      nics: nics.map((nic) => ({ ...nic })),
      block_devices: blocks.map((device: BlockDevice) => ({ ...device })),
      temps: sensorRecord(sensors),
      sensors: sensors.map((sensor: SensorReading) => ({ ...sensor })),
    };
  };
}
