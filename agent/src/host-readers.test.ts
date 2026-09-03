import { describe, expect, it } from 'vitest';
import { kilohertzToMhz, parseCpuModel, parseLoadavg } from './cpufreq.js';
import { parseMounts } from './disks.js';
import { activeDpmLine, highestDpmLine } from './gpu.js';
import { parseMeminfo } from './meminfo.js';

describe('parseMeminfo', () => {
  const sample = [
    'MemTotal:       24370500 kB',
    'MemFree:        11188144 kB',
    'MemAvailable:   21579380 kB',
    'Buffers:         1995248 kB',
    'Cached:          8298920 kB',
    'SwapTotal:       2097152 kB',
    'SwapFree:        2097152 kB',
  ].join('\n');

  it('reports totals in bytes', () => {
    expect(parseMeminfo(sample).totalBytes).toBe(24_370_500 * 1024);
  });

  it('derives used memory from available, not from free', () => {
    // Free memory understates what a workload can have, because the kernel is
    // holding gigabytes of it as reclaimable cache.
    const reading = parseMeminfo(sample);
    expect(reading.usedBytes).toBe((24_370_500 - 21_579_380) * 1024);
  });

  it('reports swap that is present but unused as zero used', () => {
    expect(parseMeminfo(sample).swapUsedBytes).toBe(0);
    expect(parseMeminfo(sample).swapTotalBytes).toBe(2_097_152 * 1024);
  });

  it('returns nulls rather than zeroes for a field it did not see', () => {
    const reading = parseMeminfo('MemTotal:       1024 kB');
    expect(reading.availableBytes).toBeNull();
    expect(reading.usedBytes).toBeNull();
    expect(reading.swapTotalBytes).toBeNull();
  });
});

describe('kilohertzToMhz', () => {
  it('converts a cpufreq reading', () => {
    expect(kilohertzToMhz('2296674')).toBe(2297);
  });

  it('rejects an unreadable or zero value rather than reporting a stopped CPU', () => {
    expect(kilohertzToMhz(null)).toBeNull();
    expect(kilohertzToMhz('')).toBeNull();
    expect(kilohertzToMhz('0')).toBeNull();
  });
});

describe('parseLoadavg', () => {
  it('reads the three averages', () => {
    expect(parseLoadavg('0.52 0.58 0.59 1/1234 56789')).toEqual({
      load1: 0.52,
      load5: 0.58,
      load15: 0.59,
    });
  });

  it('returns null for a file it cannot make sense of', () => {
    expect(parseLoadavg('')).toBeNull();
  });
});

describe('parseCpuModel', () => {
  it('takes the first model name', () => {
    const cpuinfo =
      'processor\t: 0\nmodel name\t: 12th Gen Intel(R) Core(TM) i5-1240P\ncpu MHz\t: 2200';
    expect(parseCpuModel(cpuinfo)).toBe('12th Gen Intel(R) Core(TM) i5-1240P');
  });

  it('returns null when the kernel does not report one', () => {
    expect(parseCpuModel('processor\t: 0')).toBeNull();
  });
});

describe('amdgpu clock lines', () => {
  const dpm = ['0: 500Mhz', '1: 1200Mhz *', '2: 2000Mhz'].join('\n');

  it('takes the starred level as the current clock', () => {
    expect(activeDpmLine(dpm)).toBe(1200);
  });

  it('takes the highest level as the ceiling', () => {
    expect(highestDpmLine(dpm)).toBe(2000);
  });

  it('reports null when no level is in force', () => {
    expect(activeDpmLine('0: 500Mhz\n1: 1200Mhz')).toBeNull();
  });
});

describe('parseMounts', () => {
  const mounts = [
    'proc /proc proc rw,nosuid 0 0',
    'tmpfs /run tmpfs rw,nosuid 0 0',
    '/dev/nvme0n1p2 / ext4 rw,relatime 0 0',
    '/dev/nvme0n1p1 /boot vfat rw 0 0',
    'cgroup2 /sys/fs/cgroup cgroup2 rw 0 0',
  ].join('\n');

  it('keeps only filesystems a person would call a disk', () => {
    expect(parseMounts(mounts).map((entry) => entry.mount)).toEqual(['/', '/boot']);
  });

  it('never reports tmpfs, which is memory rather than storage', () => {
    expect(parseMounts(mounts).some((entry) => entry.fsType === 'tmpfs')).toBe(false);
  });

  it('unescapes the octal that /proc/mounts uses for spaces', () => {
    const escaped = '/dev/sdb1 /mnt/my\\040disk ext4 rw 0 0';
    expect(parseMounts(escaped)[0]?.mount).toBe('/mnt/my disk');
  });
});
