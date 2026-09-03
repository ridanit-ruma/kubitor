import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface CpuReading {
  model: string | null;
  cores: number | null;
  /** Mean of the per-core current clocks, in MHz. */
  mhzAverage: number | null;
  /** The highest clock the hardware admits to, in MHz. */
  mhzMax: number | null;
  load1: number | null;
  load5: number | null;
  load15: number | null;
}

const CPU_ROOT = '/sys/devices/system/cpu';
const LOADAVG = '/proc/loadavg';
const CPUINFO = '/proc/cpuinfo';

/**
 * Reads clocks from cpufreq rather than `/proc/cpuinfo`.
 *
 * `cpu MHz` in `/proc/cpuinfo` is whatever the core happened to be doing when
 * the kernel last looked, and on some drivers it never moves at all.
 * `scaling_cur_freq` asks the driver, which is the number a person means when
 * they ask what the CPU is clocked at.
 */
export async function readCpuClocks(root = CPU_ROOT): Promise<{
  cores: number | null;
  mhzAverage: number | null;
  mhzMax: number | null;
}> {
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return { cores: null, mhzAverage: null, mhzMax: null };
  }

  const cpus = entries.filter((entry) => /^cpu\d+$/.test(entry));
  const current: number[] = [];
  let max: number | null = null;

  for (const cpu of cpus) {
    const dir = join(root, cpu, 'cpufreq');

    const cur = kilohertzToMhz(await maybeRead(join(dir, 'scaling_cur_freq')));
    if (cur !== null) current.push(cur);

    const ceiling = kilohertzToMhz(await maybeRead(join(dir, 'cpuinfo_max_freq')));
    if (ceiling !== null) max = max === null ? ceiling : Math.max(max, ceiling);
  }

  return {
    cores: cpus.length > 0 ? cpus.length : null,
    mhzAverage:
      current.length === 0
        ? null
        : Math.round(current.reduce((total, value) => total + value, 0) / current.length),
    mhzMax: max,
  };
}

/** cpufreq reports kilohertz; a dashboard wants megahertz. */
export function kilohertzToMhz(raw: string | null): number | null {
  if (raw === null) return null;
  const value = Number(raw.trim());
  return Number.isFinite(value) && value > 0 ? Math.round(value / 1000) : null;
}

export function parseLoadavg(
  text: string,
): { load1: number; load5: number; load15: number } | null {
  const match = /^([\d.]+)\s+([\d.]+)\s+([\d.]+)/.exec(text.trim());
  if (!match?.[1] || !match[2] || !match[3]) return null;

  const [load1, load5, load15] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (!Number.isFinite(load1) || !Number.isFinite(load5) || !Number.isFinite(load15)) return null;

  return { load1, load5, load15 };
}

export function parseCpuModel(text: string): string | null {
  return /^model name\s*:\s*(.+)$/m.exec(text)?.[1]?.trim() ?? null;
}

export async function readCpu(
  root = CPU_ROOT,
  loadavg = LOADAVG,
  cpuinfo = CPUINFO,
): Promise<CpuReading> {
  const clocks = await readCpuClocks(root);
  const load = parseLoadavg((await maybeRead(loadavg)) ?? '');
  const model = parseCpuModel((await maybeRead(cpuinfo)) ?? '');

  return {
    model,
    cores: clocks.cores,
    mhzAverage: clocks.mhzAverage,
    mhzMax: clocks.mhzMax,
    load1: load?.load1 ?? null,
    load5: load?.load5 ?? null,
    load15: load?.load15 ?? null,
  };
}

async function maybeRead(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}
