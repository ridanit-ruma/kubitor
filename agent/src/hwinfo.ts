import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  DMI_TABLE as DMI_TABLE_PATH,
  type MemoryDevice,
  memoryDevices,
  readDmiTable,
} from './smbios.js';

const CPU_ROOT = '/sys/devices/system/cpu';
const CPUINFO = '/proc/cpuinfo';
const EDAC_ROOT = '/sys/devices/system/edac/mc';

export interface CpuCache {
  level: number;
  /** `Data`, `Instruction` or `Unified`. */
  type: string;
  /**
   * The whole machine's cache at this level, summed over its instances.
   *
   * Reading `cpu0` alone and calling the answer "the L2 cache" understates a
   * hybrid processor by a factor of five: this chip has four L2 instances of
   * different sizes, and cpu0's is one of them. `lscpu` sums the same way.
   */
  sizeBytes: number;
  /** How many separate caches that total is spread across. */
  instances: number;
}

export interface CpuDetail {
  vendor: string | null;
  model: string | null;
  /** Physical packages. Two here means two chips, not two cores. */
  sockets: number | null;
  /** Cores per socket, which is not the thread count when SMT is on. */
  coresPerSocket: number | null;
  threads: number | null;
  family: number | null;
  modelNumber: number | null;
  stepping: number | null;
  microcode: string | null;
  /** What the kernel is currently doing with the clock. */
  governor: string | null;
  /** Instruction sets worth knowing about, not the whole flag dump. */
  features: string[];
  caches: CpuCache[];
}

export interface MemoryInventory {
  modules: MemoryModule[];
  /** Slots the controller knows about, populated or not. */
  slots: number;
}

export interface MemoryModule {
  /** `MC#0_Chan#0_DIMM#0`, `Controller0-ChannelA` — controller, channel, slot. */
  slot: string;
  sizeBytes: number;
  /** `DDR5`, `LPDDR5`, or the kernel's own spelling where firmware is silent. */
  type: string | null;
  width: string | null;
  /** `SODIMM`, `DIMM`, `Row of chips`. Only firmware knows this. */
  formFactor: string | null;
  /** What the part is rated for, in MT/s. */
  speedMts: number | null;
  /** What it was configured to run at — the speed it is running at now. */
  configuredSpeedMts: number | null;
  manufacturer: string | null;
  partNumber: string | null;
  rank: number | null;
}

/**
 * Instruction sets that change what a machine can run.
 *
 * `/proc/cpuinfo` lists two hundred flags. Almost none of them answer a
 * question anybody asks of a dashboard; these are the ones that decide whether
 * a workload will start.
 */
const NOTABLE_FEATURES = [
  'avx',
  'avx2',
  'avx512f',
  'amx_tile',
  'sse4_2',
  'aes',
  'sha_ni',
  'vmx',
  'svm',
  'sev',
  'tdx_guest',
];

export function parseCpuDetail(cpuinfo: string): Omit<CpuDetail, 'governor' | 'caches'> {
  const first = (key: string): string | null =>
    new RegExp(`^${key}\\s*:\\s*(.+)$`, 'm').exec(cpuinfo)?.[1]?.trim() ?? null;

  const values = (key: string): string[] =>
    [...cpuinfo.matchAll(new RegExp(`^${key}\\s*:\\s*(.+)$`, 'gm'))].map((match) =>
      (match[1] ?? '').trim(),
    );

  const flags = new Set((first('flags') ?? '').split(/\s+/));
  const sockets = new Set(values('physical id')).size;
  const threads = values('processor').length;

  return {
    vendor: first('vendor_id'),
    model: first('model name'),
    sockets: sockets > 0 ? sockets : threads > 0 ? 1 : null,
    coresPerSocket: integer(first('cpu cores')),
    threads: threads > 0 ? threads : null,
    family: integer(first('cpu family')),
    modelNumber: integer(first('model')),
    stepping: integer(first('stepping')),
    microcode: first('microcode'),
    features: NOTABLE_FEATURES.filter((feature) => flags.has(feature)),
  };
}

/** `48K`, `1280K`, `12288K` — the kernel's own suffix, always binary. */
export function parseCacheSize(raw: string): number | null {
  const match = /^(\d+)([KMG]?)$/.exec(raw.trim());
  if (!match?.[1]) return null;

  const scale = { '': 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3 }[match[2] ?? ''] ?? 1;
  return Number(match[1]) * scale;
}

export async function readCpuDetail(root = CPU_ROOT, cpuinfo = CPUINFO): Promise<CpuDetail> {
  const detail = parseCpuDetail((await maybeRead(cpuinfo)) ?? '');

  return {
    ...detail,
    governor: (await maybeRead(join(root, 'cpu0', 'cpufreq', 'scaling_governor')))?.trim() ?? null,
    caches: await readCaches(root),
  };
}

/**
 * Every cache in the machine, totalled per level.
 *
 * One cache is shared by the CPUs listed in its `shared_cpu_list`, and the same
 * cache appears under every one of them; counting a level means counting the
 * distinct instances. On a hybrid processor those instances differ in size,
 * which is exactly why the first core's figure cannot stand for the rest.
 */
async function readCaches(root: string): Promise<CpuCache[]> {
  let cpus: string[];
  try {
    cpus = (await readdir(root)).filter((name) => /^cpu\d+$/.test(name));
  } catch {
    return [];
  }

  const instances = new Map<string, CpuCache>();

  for (const cpu of cpus.sort()) {
    const base = join(root, cpu, 'cache');

    let entries: string[];
    try {
      entries = (await readdir(base)).filter((name) => name.startsWith('index'));
    } catch {
      continue;
    }

    for (const entry of entries) {
      const dir = join(base, entry);
      const level = Number((await maybeRead(join(dir, 'level')))?.trim());
      const type = (await maybeRead(join(dir, 'type')))?.trim();
      const size = parseCacheSize((await maybeRead(join(dir, 'size'))) ?? '');
      if (!Number.isFinite(level) || !type || size === null) continue;

      // The CPUs sharing it name the instance. Without that file every core
      // looks like it has its own, and an L3 shared by twelve is counted twelve
      // times.
      const shared = (await maybeRead(join(dir, 'shared_cpu_list')))?.trim() ?? `${cpu}/${entry}`;
      instances.set(`${level}|${type}|${shared}`, { level, type, sizeBytes: size, instances: 1 });
    }
  }

  const totals = new Map<string, CpuCache>();
  for (const cache of instances.values()) {
    const key = `${cache.level}|${cache.type}`;
    const running = totals.get(key);
    if (running) {
      running.sizeBytes += cache.sizeBytes;
      running.instances += 1;
    } else {
      totals.set(key, { ...cache });
    }
  }

  return [...totals.values()].sort((a, b) => a.level - b.level || a.type.localeCompare(b.type));
}

/**
 * Installed memory, slot by slot.
 *
 * Firmware first, the kernel second, because they disagree and firmware is
 * right. EDAC describes memory as the controller was programmed to see it: on
 * Alder Lake it calls LPDDR5 `Low-Power-DDR3-RAM` and reports 3 GiB devices as
 * 4 GiB, which added up to eight modules of 4 GiB on a machine holding 23.2.
 * Neither number was checked against the total the kernel reports for the same
 * machine, so both were shown for a week.
 *
 * EDAC remains the fallback: it needs no privilege at all, and on a machine
 * with no SMBIOS table — or a cluster that will not admit the init container
 * that copies it — the slot layout it gives is still worth having.
 */
export async function readMemoryModules(
  root = EDAC_ROOT,
  dmiTable = DMI_TABLE_PATH,
): Promise<MemoryInventory> {
  const table = await readDmiTable(dmiTable);
  if (table) {
    const inventory = fromFirmware(memoryDevices(table));
    // A table that describes no memory device tells us nothing; that is a
    // reason to ask the kernel, not to report a machine with no memory.
    if (inventory.slots > 0) return inventory;
  }

  return fromEdac(root);
}

/** What the firmware says is on the board. */
function fromFirmware(devices: readonly MemoryDevice[]): MemoryInventory {
  const modules: MemoryModule[] = [];

  for (const [index, device] of devices.entries()) {
    // Size zero is an empty slot: counted as a slot, never as a module.
    if (device.sizeBytes === null || device.sizeBytes === 0) continue;

    modules.push({
      slot: device.locator ?? device.bankLocator ?? `Device ${index}`,
      sizeBytes: device.sizeBytes,
      type: device.type,
      width: device.dataWidthBits === null ? null : `x${device.dataWidthBits}`,
      formFactor: device.formFactor,
      speedMts: device.speedMts,
      configuredSpeedMts: device.configuredSpeedMts,
      manufacturer: device.manufacturer,
      partNumber: device.partNumber,
      rank: device.rank,
    });
  }

  return { modules, slots: devices.length };
}

/** What the memory controller was told, for machines that offer nothing better. */
async function fromEdac(root: string): Promise<MemoryInventory> {
  let controllers: string[];
  try {
    controllers = (await readdir(root)).filter((name) => /^mc\d+$/.test(name));
  } catch {
    return { modules: [], slots: 0 };
  }

  const modules: MemoryModule[] = [];
  let slots = 0;

  for (const controller of controllers.sort()) {
    const base = join(root, controller);

    let found: string[];
    try {
      found = (await readdir(base)).filter((name) => /^dimm\d+$/.test(name));
    } catch {
      continue;
    }

    for (const slot of found.sort()) {
      const dir = join(base, slot);
      slots += 1;

      // EDAC reports size in mebibytes. An empty slot reports zero, and an
      // empty slot is a slot but not a module.
      const megabytes = Number((await maybeRead(join(dir, 'size')))?.trim());
      if (!Number.isFinite(megabytes) || megabytes <= 0) continue;

      modules.push({
        slot: (await maybeRead(join(dir, 'dimm_label')))?.trim() || `${controller}/${slot}`,
        sizeBytes: megabytes * 1024 ** 2,
        type: (await maybeRead(join(dir, 'dimm_mem_type')))?.trim() || null,
        width: (await maybeRead(join(dir, 'dimm_dev_type')))?.trim() || null,
        formFactor: null,
        speedMts: null,
        configuredSpeedMts: null,
        manufacturer: null,
        partNumber: null,
        rank: null,
      });
    }
  }

  return { modules, slots };
}

function integer(raw: string | null): number | null {
  if (raw === null) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

async function maybeRead(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}
