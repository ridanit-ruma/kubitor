import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface GpuReading {
  card: string;
  /** Kernel driver: `i915`, `xe`, `amdgpu`, `nouveau`. */
  driver: string | null;
  /** `8086:46b3`. Reported as-is rather than guessed at a marketing name. */
  pciId: string | null;
  /** `Intel`, `AMD`, `NVIDIA` — from the PCI vendor id, which is unambiguous. */
  vendor: string | null;
  /** `8.0 GT/s PCIe` and its lane count. Absent on an integrated GPU. */
  linkSpeed: string | null;
  linkWidth: number | null;
  mhzCur: number | null;
  mhzMax: number | null;
  /** Memory clock, where the driver publishes one. */
  memMhzCur: number | null;
  memMhzMax: number | null;
  busyPercent: number | null;
  memTotalBytes: number | null;
  memUsedBytes: number | null;
  /**
   * True when the GPU has no memory of its own and uses system RAM.
   *
   * The distinction matters on screen: an integrated GPU reporting no VRAM is
   * not a driver that failed to answer, and showing a blank there would read as
   * one.
   */
  memShared: boolean;
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
      vendor: vendorOf(pciId),
      linkSpeed: linkOf(await maybeRead(join(deviceDir, 'current_link_speed'))),
      linkWidth: positive(await maybeNumber(join(deviceDir, 'current_link_width'))),
      mhzCur: await currentClock(cardDir, deviceDir),
      mhzMax: await maximumClock(cardDir, deviceDir),
      memMhzCur: activeDpmLine(await maybeRead(join(deviceDir, 'pp_dpm_mclk'))),
      memMhzMax: highestDpmLine(await maybeRead(join(deviceDir, 'pp_dpm_mclk'))),
      busyPercent: clampPercent(await maybeNumber(join(deviceDir, 'gpu_busy_percent'))),
      ...(await memory(cardDir, deviceDir)),
    });
  }

  return readings;
}

/**
 * Dedicated video memory, and whether there is any.
 *
 * amdgpu publishes both figures in bytes; Intel's discrete cards publish a
 * total only. An integrated GPU publishes neither because it has none — it
 * carves out system RAM — so it is reported as shared rather than as unknown.
 */
async function memory(
  cardDir: string,
  deviceDir: string,
): Promise<Pick<GpuReading, 'memTotalBytes' | 'memUsedBytes' | 'memShared'>> {
  const amd = await maybeNumber(join(deviceDir, 'mem_info_vram_total'));
  if (amd !== null) {
    return {
      memTotalBytes: amd,
      memUsedBytes: await maybeNumber(join(deviceDir, 'mem_info_vram_used')),
      memShared: false,
    };
  }

  const intel = await maybeNumber(join(cardDir, 'lmem_total_bytes'));
  if (intel !== null) {
    return { memTotalBytes: intel, memUsedBytes: null, memShared: false };
  }

  return { memTotalBytes: null, memUsedBytes: null, memShared: true };
}

async function currentClock(cardDir: string, deviceDir: string): Promise<number | null> {
  // The frequency the hardware actually settled at, where it is published;
  // `gt_cur_freq_mhz` is the one the driver asked for.
  const actual = await maybeNumber(join(cardDir, 'gt_act_freq_mhz'));
  if (actual !== null) return actual;

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

/**
 * The vendors a GPU is likely to come from.
 *
 * A full name needs the PCI id database, which is a package this agent does not
 * carry. The vendor half of the id is a fixed, tiny set, and naming it turns
 * `8086:46b3` into something a reader recognizes without pretending to know the
 * marketing name of the part.
 */
const PCI_VENDORS: Record<string, string> = {
  '8086': 'Intel',
  '10de': 'NVIDIA',
  '1002': 'AMD',
  '1a03': 'ASPEED',
  '102b': 'Matrox',
  '15ad': 'VMware',
  '1af4': 'Red Hat',
};

function vendorOf(pciId: string | null): string | null {
  return pciId === null ? null : (PCI_VENDORS[pciId.split(':')[0] ?? ''] ?? null);
}

/** An integrated GPU answers `Unknown`, which is a driver saying "no link". */
function linkOf(raw: string | null): string | null {
  const value = raw?.trim();
  return !value || value === 'Unknown' ? null : value;
}

function positive(value: number | null): number | null {
  return value !== null && value > 0 ? value : null;
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
