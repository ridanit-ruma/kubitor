import { readFile } from 'node:fs/promises';

export interface MemoryReading {
  totalBytes: number | null;
  availableBytes: number | null;
  usedBytes: number | null;
  cachedBytes: number | null;
  swapTotalBytes: number | null;
  swapUsedBytes: number | null;
}

const MEMINFO = '/proc/meminfo';

/**
 * Host RAM, which is not what the kubelet reports.
 *
 * The kubelet's `memory.workingSetBytes` is the sum of what containers hold; a
 * machine with 24 GiB of RAM and 2 GiB of container working set is 9% busy by
 * that measure and says nothing about the other 22 GiB. This reads the real
 * thing, and `MemAvailable` rather than `MemFree`, because free memory that the
 * kernel is using as cache is still available to a workload.
 */
export function parseMeminfo(text: string): MemoryReading {
  const values = new Map<string, number>();

  for (const line of text.split('\n')) {
    const match = /^(\w+):\s+(\d+)(?:\s+kB)?$/.exec(line.trim());
    if (!match?.[1] || !match[2]) continue;
    // Every value /proc/meminfo reports in this form is in kibibytes.
    values.set(match[1], Number(match[2]) * 1024);
  }

  const total = values.get('MemTotal') ?? null;
  const available = values.get('MemAvailable') ?? null;
  const swapTotal = values.get('SwapTotal') ?? null;
  const swapFree = values.get('SwapFree') ?? null;

  return {
    totalBytes: total,
    availableBytes: available,
    usedBytes: total !== null && available !== null ? total - available : null,
    cachedBytes: values.get('Cached') ?? null,
    swapTotalBytes: swapTotal,
    swapUsedBytes: swapTotal !== null && swapFree !== null ? swapTotal - swapFree : null,
  };
}

export async function readMemory(path = MEMINFO): Promise<MemoryReading> {
  try {
    return parseMeminfo(await readFile(path, 'utf8'));
  } catch {
    return {
      totalBytes: null,
      availableBytes: null,
      usedBytes: null,
      cachedBytes: null,
      swapTotalBytes: null,
      swapUsedBytes: null,
    };
  }
}
