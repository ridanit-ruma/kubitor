import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const CPU_ROOT = '/sys/devices/system/cpu';
const CPUINFO = '/proc/cpuinfo';
const EDAC_ROOT = '/sys/devices/system/edac/mc';

export interface CpuCache {
  level: number;
  /** `Data`, `Instruction` or `Unified`. */
  type: string;
  sizeBytes: number;
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
  /** `MC#0_Chan#0_DIMM#0` — which controller, channel and slot. */
  slot: string;
  sizeBytes: number;
  /** `Unbuffered-DDR4`, `Low-Power-DDR3-RAM`, and so on. */
  type: string | null;
  width: string | null;
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
    caches: await readCaches(join(root, 'cpu0', 'cache')),
  };
}

async function readCaches(root: string): Promise<CpuCache[]> {
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return [];
  }

  const caches: CpuCache[] = [];
  for (const entry of entries.filter((name) => name.startsWith('index'))) {
    const level = Number((await maybeRead(join(root, entry, 'level')))?.trim());
    const type = (await maybeRead(join(root, entry, 'type')))?.trim();
    const size = parseCacheSize((await maybeRead(join(root, entry, 'size'))) ?? '');

    if (!Number.isFinite(level) || !type || size === null) continue;
    caches.push({ level, type, sizeBytes: size });
  }

  return caches.sort((a, b) => a.level - b.level || a.type.localeCompare(b.type));
}

/**
 * Installed memory modules, slot by slot.
 *
 * From EDAC rather than SMBIOS: the DMI tables that hold manufacturer and speed
 * are root-only, and this agent runs as nobody. What EDAC exposes — which slot,
 * how large, what type — is the part that answers "can I add more memory", and
 * it is world-readable.
 */
export async function readMemoryModules(root = EDAC_ROOT): Promise<MemoryInventory> {
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
