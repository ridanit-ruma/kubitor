import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface GpuReading {
  card: string;
  /** Kernel driver: `i915`, `xe`, `amdgpu`, `nouveau`. */
  driver: string | null;
  /** `8086:46b3`. Reported as-is rather than guessed at a marketing name. */
  pciId: string | null;
  mhzCur: number | null;
  mhzMax: number | null;
  busyPercent: number | null;
  memTotalBytes: number | null;
  memUsedBytes: number | null;
}

const DRM_ROOT = '/sys/class/drm';

/**
 * GPU clocks, per driver, from sysfs.
 *
 * There is no common interface: i915 publishes `gt_cur_freq_mhz` at the card,
 * xe buries the same number under `device/tile0/gt0/freq0/cur_freq`, and amdgpu
 * marks the active line of `pp_dpm_sclk` with a trailing `*`. Each is tried in
 * turn and a card that answers none of them still appears, with null clocks —
 * knowing a GPU is present and unreadable beats not listing it.
 */
export async function readGpus(root = DRM_ROOT): Promise<GpuReading[]> {
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return [];
  }

  const cards = entries.filter((entry) => /^card\d+$/.test(entry)).sort();
  const readings: GpuReading[] = [];

  for (const card of cards) {
    const cardDir = join(root, card);
    const deviceDir = join(cardDir, 'device');

    const uevent = (await maybeRead(join(deviceDir, 'uevent'))) ?? '';
    const driver = /^DRIVER=(.+)$/m.exec(uevent)?.[1]?.trim() ?? null;
    const pciId = /^PCI_ID=(.+)$/m.exec(uevent)?.[1]?.trim().toLowerCase() ?? null;

    readings.push({
      card,
      driver,
      pciId,
      mhzCur: await currentClock(cardDir, deviceDir),
      mhzMax: await maximumClock(cardDir, deviceDir),
      busyPercent: clampPercent(await maybeNumber(join(deviceDir, 'gpu_busy_percent'))),
      // amdgpu reports VRAM in bytes already.
      memTotalBytes: await maybeNumber(join(deviceDir, 'mem_info_vram_total')),
      memUsedBytes: await maybeNumber(join(deviceDir, 'mem_info_vram_used')),
    });
  }

  return readings;
}

async function currentClock(cardDir: string, deviceDir: string): Promise<number | null> {
  const i915 = await maybeNumber(join(cardDir, 'gt_cur_freq_mhz'));
  if (i915 !== null) return i915;

  // xe reports hertz-per-thousand under a per-tile path.
  const xe = await maybeNumber(join(deviceDir, 'tile0', 'gt0', 'freq0', 'cur_freq'));
  if (xe !== null) return xe;

  return activeDpmLine(await maybeRead(join(deviceDir, 'pp_dpm_sclk')));
}

async function maximumClock(cardDir: string, deviceDir: string): Promise<number | null> {
  const i915 = await maybeNumber(join(cardDir, 'gt_max_freq_mhz'));
  if (i915 !== null) return i915;

  const xe = await maybeNumber(join(deviceDir, 'tile0', 'gt0', 'freq0', 'max_freq'));
  if (xe !== null) return xe;

  return highestDpmLine(await maybeRead(join(deviceDir, 'pp_dpm_sclk')));
}

/** amdgpu: `1: 1200Mhz *` — the starred line is the level in force. */
export function activeDpmLine(text: string | null): number | null {
  if (text === null) return null;

  for (const line of text.split('\n')) {
    if (!line.includes('*')) continue;
    const value = /(\d+)\s*Mhz/i.exec(line)?.[1];
    if (value) return Number(value);
  }
  return null;
}

export function highestDpmLine(text: string | null): number | null {
  if (text === null) return null;

  const values = [...text.matchAll(/(\d+)\s*Mhz/gi)].map((match) => Number(match[1]));
  return values.length === 0 ? null : Math.max(...values);
}

function clampPercent(value: number | null): number | null {
  if (value === null) return null;
  return Math.min(100, Math.max(0, value));
}

async function maybeNumber(path: string): Promise<number | null> {
  const raw = await maybeRead(path);
  if (raw === null) return null;

  const value = Number(raw.trim());
  return Number.isFinite(value) ? value : null;
}

async function maybeRead(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}
