import { readFile } from 'node:fs/promises';

const PROC_STAT = '/proc/stat';

export interface CpuTimes {
  /** Everything the CPU could have been doing. */
  total: number;
  /** Time it was doing nothing, including waiting on I/O. */
  idle: number;
}

/**
 * The aggregate `cpu` line of `/proc/stat`.
 *
 * `iowait` counts as idle: the core was available and nothing was ready to run
 * on it. Counting it as busy is a common mistake that makes a machine waiting
 * on a slow disk look CPU-bound.
 */
export function parseCpuTimes(text: string): CpuTimes | null {
  const line = text.split('\n').find((candidate) => /^cpu\s/.test(candidate));
  if (!line) return null;

  const fields = line.trim().split(/\s+/).slice(1).map(Number);
  if (fields.length < 5 || fields.some((value) => !Number.isFinite(value))) return null;

  const total = fields.reduce((sum, value) => sum + value, 0);
  const idle = (fields[3] ?? 0) + (fields[4] ?? 0);

  return { total, idle };
}

/** The share of the interval the CPU was busy, or null on the first reading. */
export function utilization(previous: CpuTimes | null, current: CpuTimes): number | null {
  if (!previous) return null;

  const total = current.total - previous.total;
  const idle = current.idle - previous.idle;

  // A counter that went backwards means the machine rebooted, or the file was
  // read twice in the same jiffy. Neither is a measurement.
  if (total <= 0 || idle < 0) return null;

  return Math.min(100, Math.max(0, ((total - idle) / total) * 100));
}

/**
 * CPU utilization between calls.
 *
 * A percentage is what a person means by "how busy is this machine", and unlike
 * the kubelet's millicores it needs no capacity beside it to be readable.
 */
export function createCpuMeter(path = PROC_STAT) {
  let previous: CpuTimes | null = null;

  return async function measure(): Promise<number | null> {
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch {
      return null;
    }

    const current = parseCpuTimes(text);
    if (!current) return null;

    const percent = utilization(previous, current);
    previous = current;
    return percent;
  };
}
