import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { rate } from './netdev.js';

const SYS_BLOCK = '/sys/block';
const DISKSTATS = '/proc/diskstats';
/** The kernel reports block counters in 512-byte sectors regardless of device. */
const SECTOR_BYTES = 512;

export interface BlockDevice {
  name: string;
  model: string | null;
  sizeBytes: number | null;
  /** False for solid state. Null where the kernel does not say. */
  rotational: boolean | null;
  /** `8.0 GT/s PCIe` and its lane count, for devices on a PCIe link. */
  linkSpeed: string | null;
  linkWidth: number | null;
  schedulerQueue: string | null;
  readBytesPerSecond: number | null;
  writeBytesPerSecond: number | null;
  readsPerSecond: number | null;
  writesPerSecond: number | null;
}

interface DiskCounters {
  reads: number;
  writes: number;
  sectorsRead: number;
  sectorsWritten: number;
}

/**
 * `/proc/diskstats`, keyed by device name.
 *
 * Partitions appear alongside whole devices and would double-count everything;
 * they are dropped by the caller, which knows which names are whole devices
 * because `/sys/block` lists exactly those.
 */
export function parseDiskstats(text: string): Map<string, DiskCounters> {
  const counters = new Map<string, DiskCounters>();

  for (const line of text.split('\n')) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 10) continue;

    const name = fields[2];
    const numbers = fields.slice(3).map(Number);
    if (!name || numbers.some((value) => !Number.isFinite(value))) continue;

    counters.set(name, {
      reads: numbers[0] ?? 0,
      sectorsRead: numbers[2] ?? 0,
      writes: numbers[4] ?? 0,
      sectorsWritten: numbers[6] ?? 0,
    });
  }

  return counters;
}

/**
 * The machine's disks, with what they are and what they are doing.
 *
 * Loop and ram devices are excluded: they are files and memory wearing a block
 * device's clothes, and listing them as storage is how a node with two SSDs
 * ends up claiming ten drives.
 */
export function createBlockMeter(sysBlock = SYS_BLOCK, diskstats = DISKSTATS) {
  let previous = new Map<string, DiskCounters>();
  let previousAt = 0;

  return async function measure(now: number): Promise<BlockDevice[]> {
    let names: string[];
    try {
      names = (await readdir(sysBlock)).filter(isRealDevice);
    } catch {
      return [];
    }

    const current = parseDiskstats((await maybeRead(diskstats)) ?? '');
    const elapsed = previousAt === 0 ? 0 : now - previousAt;
    const devices: BlockDevice[] = [];

    for (const name of names.sort()) {
      const root = join(sysBlock, name);
      const sectors = Number((await maybeRead(join(root, 'size')))?.trim());
      const rotational = (await maybeRead(join(root, 'queue', 'rotational')))?.trim();

      const before = previous.get(name);
      const after = current.get(name);

      devices.push({
        name,
        model: (await maybeRead(join(root, 'device', 'model')))?.trim() || null,
        sizeBytes: Number.isFinite(sectors) && sectors > 0 ? sectors * SECTOR_BYTES : null,
        rotational: rotational === undefined ? null : rotational === '1',
        linkSpeed:
          (await maybeRead(join(root, 'device', 'device', 'current_link_speed')))?.trim() ?? null,
        linkWidth: numberOf(await maybeRead(join(root, 'device', 'device', 'current_link_width'))),
        schedulerQueue: scheduler(await maybeRead(join(root, 'queue', 'scheduler'))),
        readBytesPerSecond: throughput(before?.sectorsRead, after?.sectorsRead, elapsed),
        writeBytesPerSecond: throughput(before?.sectorsWritten, after?.sectorsWritten, elapsed),
        readsPerSecond: before && after ? rate(before.reads, after.reads, elapsed) : null,
        writesPerSecond: before && after ? rate(before.writes, after.writes, elapsed) : null,
      });
    }

    previous = current;
    previousAt = now;
    return devices;
  };
}

function throughput(
  before: number | undefined,
  after: number | undefined,
  elapsedMs: number,
): number | null {
  if (before === undefined || after === undefined) return null;
  const sectors = rate(before, after, elapsedMs);
  return sectors === null ? null : sectors * SECTOR_BYTES;
}

/** `mq-deadline [none]` — the active one is the bracketed one. */
function scheduler(raw: string | null): string | null {
  return /\[([^\]]+)\]/.exec(raw ?? '')?.[1] ?? null;
}

function isRealDevice(name: string): boolean {
  return !/^(loop|ram|zram|dm-|sr)\d*/.test(name);
}

function numberOf(raw: string | null): number | null {
  if (raw === null) return null;
  const value = Number(raw.trim());
  return Number.isFinite(value) && value > 0 ? value : null;
}

async function maybeRead(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}
