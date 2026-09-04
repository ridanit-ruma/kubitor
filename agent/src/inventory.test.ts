import { describe, expect, it } from 'vitest';
import { parseDiskstats } from './blockdev.js';
import { parseCacheSize, parseCpuDetail } from './hwinfo.js';
import { isPhysical, parseNetDev, rate } from './netdev.js';

const NET_DEV = [
  'Inter-|   Receive                    |  Transmit',
  ' face |bytes packets errs drop fifo frame compressed multicast|bytes packets errs drop fifo colls carrier compressed',
  '    lo: 40535449592 128197996    0    0    0     0          0         0 40535449592 128197996    0    0    0     0       0          0',
  'enp3s0: 16810894121 31644558    0    2    0     0          0     52085 31939496695 12832582    0    0    0     0       0          0',
  'lxc0f7837ae201d: 100 1 0 0 0 0 0 0 200 2 0 0 0 0 0 0',
].join('\n');

describe('parseNetDev', () => {
  it('reads receive and transmit counters', () => {
    const enp = parseNetDev(NET_DEV).find((entry) => entry.name === 'enp3s0');
    expect(enp?.rxBytes).toBe(16_810_894_121);
    expect(enp?.txBytes).toBe(31_939_496_695);
    expect(enp?.rxDropped).toBe(2);
  });

  it('skips the two header lines', () => {
    expect(parseNetDev(NET_DEV).map((entry) => entry.name)).toEqual([
      'lo',
      'enp3s0',
      'lxc0f7837ae201d',
    ]);
  });
});

describe('isPhysical', () => {
  /**
   * Cilium names every pod's host-side veth `lxc<hash>`. Summing those reports
   * several times the machine's real traffic.
   */
  it('excludes the interfaces whose traffic is counted elsewhere', () => {
    expect(isPhysical('lxc0f7837ae201d')).toBe(false);
    expect(isPhysical('cali123')).toBe(false);
    expect(isPhysical('lo')).toBe(false);
    expect(isPhysical('cilium_host')).toBe(false);
  });

  it('keeps the machine’s own interfaces', () => {
    expect(isPhysical('enp3s0')).toBe(true);
    expect(isPhysical('wlo1')).toBe(true);
    expect(isPhysical('bond0')).toBe(true);
  });
});

describe('rate', () => {
  it('converts a counter delta to a per-second figure', () => {
    expect(rate(1000, 3000, 2000)).toBe(1000);
  });

  it('reports nothing across a counter reset', () => {
    // An interface that was brought down and up is not negative traffic.
    expect(rate(3000, 1000, 1000)).toBeNull();
  });

  it('reports nothing without an interval to divide by', () => {
    expect(rate(0, 100, 0)).toBeNull();
  });
});

describe('parseDiskstats', () => {
  const stats = [
    ' 259       0 nvme0n1 2817 16 73568 583 1389619 207709 23195496 211540 0 222898 346941',
    ' 259       3 nvme1n1p2 77063 17875 6174042 15121 12527072 9396486 241161848 8794586 0 6943519 8809708',
    'garbage',
  ].join('\n');

  it('reads reads, writes and the sectors behind them', () => {
    const device = parseDiskstats(stats).get('nvme0n1');
    expect(device).toEqual({
      reads: 2817,
      sectorsRead: 73_568,
      writes: 1_389_619,
      sectorsWritten: 23_195_496,
    });
  });

  it('keeps partitions, which the caller filters by whole-device name', () => {
    expect(parseDiskstats(stats).has('nvme1n1p2')).toBe(true);
  });

  it('ignores a line it cannot read', () => {
    expect(parseDiskstats(stats).has('garbage')).toBe(false);
  });
});

describe('parseCpuDetail', () => {
  const cpuinfo = [
    'processor\t: 0',
    'vendor_id\t: GenuineIntel',
    'cpu family\t: 6',
    'model\t\t: 154',
    'model name\t: 12th Gen Intel(R) Core(TM) i3-1220P',
    'stepping\t: 4',
    'microcode\t: 0x43b',
    'physical id\t: 0',
    'siblings\t: 12',
    'cpu cores\t: 10',
    'flags\t\t: fpu vme avx avx2 aes sha_ni vmx sse4_2',
    '',
    'processor\t: 1',
    'physical id\t: 0',
    'cpu cores\t: 10',
  ].join('\n');

  it('separates sockets, cores and threads', () => {
    const cpu = parseCpuDetail(cpuinfo);
    expect(cpu.sockets).toBe(1);
    expect(cpu.coresPerSocket).toBe(10);
    expect(cpu.threads).toBe(2);
  });

  it('reads the identity a firmware bug report needs', () => {
    const cpu = parseCpuDetail(cpuinfo);
    expect(cpu.model).toBe('12th Gen Intel(R) Core(TM) i3-1220P');
    expect(cpu.family).toBe(6);
    expect(cpu.stepping).toBe(4);
    expect(cpu.microcode).toBe('0x43b');
  });

  /** Two hundred flags answer no question a dashboard is asked. */
  it('keeps only the instruction sets that decide whether a workload runs', () => {
    expect(parseCpuDetail(cpuinfo).features).toEqual([
      'avx',
      'avx2',
      'sse4_2',
      'aes',
      'sha_ni',
      'vmx',
    ]);
  });

  it('reports nulls rather than guesses for a file it cannot read', () => {
    const cpu = parseCpuDetail('');
    expect(cpu.model).toBeNull();
    expect(cpu.threads).toBeNull();
    expect(cpu.features).toEqual([]);
  });
});

describe('parseCacheSize', () => {
  it('reads the kernel’s binary suffixes', () => {
    expect(parseCacheSize('48K')).toBe(49_152);
    expect(parseCacheSize('12288K')).toBe(12_582_912);
    expect(parseCacheSize('2M')).toBe(2_097_152);
    expect(parseCacheSize('512')).toBe(512);
  });

  it('refuses something that is not a size', () => {
    expect(parseCacheSize('unknown')).toBeNull();
  });
});
