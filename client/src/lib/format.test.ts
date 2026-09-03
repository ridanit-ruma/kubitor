import { describe, expect, it } from 'vitest';
import {
  formatAge,
  formatBytes,
  formatBytesPerSecond,
  formatCelsius,
  formatCpu,
  formatDuration,
  formatPercent,
  niceCeiling,
} from './format';

const NOW = 1_756_800_000_000;

describe('formatBytes', () => {
  /** The kernel counts in powers of two; showing 1 kB for 1024 B is a lie. */
  it('uses binary units', () => {
    expect(formatBytes(1024)).toBe('1.0 KiB');
    expect(formatBytes(1_048_576)).toBe('1.0 MiB');
    expect(formatBytes(2_147_483_648)).toBe('2.0 GiB');
  });

  it('shows whole bytes without a decimal', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(0)).toBe('0 B');
  });

  it('reports unknown rather than zero', () => {
    expect(formatBytes(null)).toBe('—');
    expect(formatBytes(undefined)).toBe('—');
    expect(formatBytes(Number.NaN)).toBe('—');
  });

  it('appends a rate suffix', () => {
    expect(formatBytesPerSecond(1024)).toBe('1.0 KiB/s');
    expect(formatBytesPerSecond(null)).toBe('—');
  });
});

describe('formatCpu', () => {
  it('stays in millicores below a whole core', () => {
    expect(formatCpu(250)).toBe('250m');
  });

  it('switches to cores once there is one', () => {
    expect(formatCpu(2500)).toBe('2.50 cores');
  });

  it('reports unknown rather than zero', () => {
    expect(formatCpu(null)).toBe('—');
  });
});

describe('formatPercent', () => {
  it('keeps one decimal by default', () => {
    expect(formatPercent(12.345)).toBe('12.3%');
  });

  it('reports unknown when there was no capacity to divide by', () => {
    expect(formatPercent(null)).toBe('—');
  });
});

describe('formatAge', () => {
  /**
   * The label must hold still while a reading is fresh. Counting seconds
   * rewrote it on every tick, and text moving in the corner of the eye reads as
   * a fault rather than as freshness.
   */
  it('says nothing new for the whole first minute', () => {
    expect(formatAge(NOW, NOW)).toBe('current');
    expect(formatAge(NOW - 1000, NOW)).toBe('current');
    expect(formatAge(NOW - 12_000, NOW)).toBe('current');
    expect(formatAge(NOW - 59_000, NOW)).toBe('current');
  });

  it('reports staleness in minutes, hours and days', () => {
    expect(formatAge(NOW - 5 * 60_000, NOW)).toBe('5m old');
    expect(formatAge(NOW - 3 * 3_600_000, NOW)).toBe('3h old');
    expect(formatAge(NOW - 2 * 86_400_000, NOW)).toBe('2d old');
  });

  it('rounds down, so a reading is never reported younger than it is', () => {
    expect(formatAge(NOW - 119_000, NOW)).toBe('1m old');
  });

  it('says so when there is nothing to age', () => {
    expect(formatAge(null, NOW)).toBe('no data');
  });

  it('never reports a negative age from a clock skew', () => {
    expect(formatAge(NOW + 5000, NOW)).toBe('current');
  });
});

describe('formatCelsius and formatDuration', () => {
  it('formats a temperature to one decimal', () => {
    expect(formatCelsius(41.53)).toBe('41.5°C');
    expect(formatCelsius(null)).toBe('—');
  });

  it('keeps sub-second durations in milliseconds', () => {
    expect(formatDuration(6)).toBe('6 ms');
    expect(formatDuration(1500)).toBe('1.50 s');
    expect(formatDuration(null)).toBe('—');
  });
});

describe('niceCeiling', () => {
  /**
   * An axis label is only useful if it is a number a reader recognizes. The
   * peak plus ten percent produces 1.37 GiB, which is nobody's landmark.
   */
  it('rounds up to a landmark', () => {
    expect(niceCeiling(0.8)).toBe(1);
    expect(niceCeiling(1.2)).toBe(2);
    expect(niceCeiling(2.4)).toBe(2.5);
    expect(niceCeiling(37)).toBe(50);
    expect(niceCeiling(640)).toBe(1000);
  });

  it('leaves a value that is already a landmark alone', () => {
    expect(niceCeiling(100)).toBe(100);
  });

  it('gives an empty chart a usable axis', () => {
    expect(niceCeiling(0)).toBe(1);
    expect(niceCeiling(Number.NaN)).toBe(1);
  });
});
