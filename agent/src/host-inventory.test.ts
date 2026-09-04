import { mkdirSync, mkdtempSync, statfsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readDisks } from './disks.js';
import { readCpuDetail, readMemoryModules } from './hwinfo.js';

function fixture(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `kubitor-${prefix}-`));
}

function write(path: string, value: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `${value}\n`);
}

/**
 * A hybrid processor's caches, as sysfs presents them.
 *
 * One performance core running two threads — cpu0 and cpu1, which share its
 * 48 KiB L1d and its 1.25 MiB L2 — and four efficiency cores with 32 KiB each
 * and one 2 MiB L2 between them. One L3 serves all six. Every cache appears
 * under every CPU that shares it, which is the whole difficulty.
 */
function hybridCaches(root: string): void {
  const cache = (
    cpu: number,
    index: number,
    level: number,
    type: string,
    size: string,
    shared: string,
  ) => {
    const dir = join(root, `cpu${cpu}`, 'cache', `index${index}`);
    mkdirSync(dir, { recursive: true });
    write(join(dir, 'level'), String(level));
    write(join(dir, 'type'), type);
    write(join(dir, 'size'), size);
    write(join(dir, 'shared_cpu_list'), shared);
  };

  for (const cpu of [0, 1]) {
    cache(cpu, 0, 1, 'Data', '48K', '0-1');
    cache(cpu, 2, 2, 'Unified', '1280K', '0-1');
    cache(cpu, 3, 3, 'Unified', '12288K', '0-9');
  }
  for (const cpu of [2, 3, 4, 5]) {
    cache(cpu, 0, 1, 'Data', '32K', String(cpu));
    cache(cpu, 2, 2, 'Unified', '2048K', '2-5');
    cache(cpu, 3, 3, 'Unified', '12288K', '0-9');
  }
}

describe('readCpuDetail caches', () => {
  it('reports the machine, not the first core it happens to read', async () => {
    const root = fixture('cpu');
    hybridCaches(root);

    const { caches } = await readCpuDetail(root, join(root, 'nothing'));
    const l2 = caches.find((cache) => cache.level === 2);
    const l1d = caches.find((cache) => cache.level === 1);

    // One 1.25 MiB cache plus one shared 2 MiB cache — not "1.25 MiB", which
    // is what reading cpu0 alone reported for a machine holding 3.25 MiB.
    expect(l2?.sizeBytes).toBe(1_310_720 + 2_097_152);
    expect(l2?.instances).toBe(2);
    expect(l1d?.sizeBytes).toBe(49_152 + 4 * 32_768);
    expect(l1d?.instances).toBe(5);
  });

  /** One L3 shared by ten cores is one L3, not ten. */
  it('counts a shared cache once', async () => {
    const root = fixture('cpu');
    hybridCaches(root);

    const { caches } = await readCpuDetail(root, join(root, 'nothing'));
    const l3 = caches.find((cache) => cache.level === 3);

    expect(l3?.instances).toBe(1);
    expect(l3?.sizeBytes).toBe(12_582_912);
  });
});

describe('readMemoryModules', () => {
  function edac(root: string): void {
    for (const slot of [0, 1]) {
      const dir = join(root, 'mc0', `dimm${slot}`);
      mkdirSync(dir, { recursive: true });
      write(join(dir, 'size'), '4096');
      write(join(dir, 'dimm_label'), `MC#0_Chan#${slot}_DIMM#0`);
      // What this kernel driver says about hardware it cannot fully identify.
      write(join(dir, 'dimm_mem_type'), 'Low-Power-DDR3-RAM');
    }
  }

  /** A type 17 structure carrying LPDDR5, 3 GiB, soldered, 6600 rated. */
  function dmiTable(): Buffer {
    const data = Buffer.alloc(0x5c);
    data[0] = 17;
    data[1] = 0x5c;
    data.writeUInt16LE(3072, 0x0c);
    data[0x0e] = 0x0b;
    data[0x10] = 1;
    data[0x12] = 0x23;
    data.writeUInt16LE(6600, 0x15);
    data.writeUInt16LE(5200, 0x20);
    const strings = Buffer.from('Controller0-ChannelA\0\0', 'latin1');
    return Buffer.concat([data, strings, Buffer.from([127, 4, 0, 0, 0, 0])]);
  }

  /**
   * The kernel and the firmware disagree, and the firmware is right: EDAC
   * called this machine's LPDDR5 `Low-Power-DDR3-RAM` and its 3 GiB devices
   * 4 GiB, which added up to 32 GiB on a machine holding 23.
   */
  it('believes the firmware over the memory controller', async () => {
    const root = fixture('mem');
    edac(root);
    const table = join(root, 'DMI');
    writeFileSync(table, dmiTable());

    const inventory = await readMemoryModules(root, table);

    expect(inventory.modules).toHaveLength(1);
    expect(inventory.modules[0]?.type).toBe('LPDDR5');
    expect(inventory.modules[0]?.sizeBytes).toBe(3 * 1024 ** 3);
    expect(inventory.modules[0]?.formFactor).toBe('Row of chips');
    expect(inventory.modules[0]?.configuredSpeedMts).toBe(5200);
  });

  it('falls back to the kernel where no firmware table was readable', async () => {
    const root = fixture('mem');
    edac(root);

    const inventory = await readMemoryModules(root, join(root, 'absent'));

    expect(inventory.slots).toBe(2);
    expect(inventory.modules[0]?.type).toBe('Low-Power-DDR3-RAM');
    expect(inventory.modules[0]?.formFactor).toBeNull();
  });

  it('reports nothing on a machine that exposes neither', async () => {
    const root = fixture('mem');
    expect(await readMemoryModules(join(root, 'none'), join(root, 'none'))).toEqual({
      modules: [],
      slots: 0,
    });
  });
});

describe('readDisks', () => {
  /**
   * `df` counts the root reserve as neither used nor available. Counting it as
   * used put 33.5 GiB on screen for a filesystem holding 21.6.
   */
  it('measures used the way df does, and available separately', async () => {
    const root = fixture('fs');
    const mounts = join(root, 'mounts');
    writeFileSync(mounts, `/dev/sda1 / ext4 rw 0 0\n`);

    const [disk] = await readDisks(mounts, root);
    const stats = statfsSync(root);

    expect(disk?.usedBytes).toBe(
      (Number(stats.blocks) - Number(stats.bfree)) * Number(stats.bsize),
    );
    expect(disk?.availableBytes).toBe(Number(stats.bavail) * Number(stats.bsize));
    // The reserve is the gap: available is never simply total less used.
    expect(disk?.availableBytes).toBeLessThanOrEqual(
      (disk?.totalBytes ?? 0) - (disk?.usedBytes ?? 0),
    );
  });
});
