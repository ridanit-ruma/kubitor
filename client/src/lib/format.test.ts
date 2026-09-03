import { describe, expect, it } from 'vitest';
import {
  formatAge,
  formatBytes,
  formatBytesPerSecond,
  formatCelsius,
  formatCpu,
  formatDuration,
  formatPercent,
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
   * The dashboard refreshes every second; the reading underneath may not have.
   * Saying so is what separates a live display from a convincing one.
   */
  it('counts seconds, minutes, hours and days', () => {
    expect(formatAge(NOW, NOW)).toBe('just now');
    expect(formatAge(NOW - 12_000, NOW)).toBe('12s ago');
    expect(formatAge(NOW - 5 * 60_000, NOW)).toBe('5m ago');
    expect(formatAge(NOW - 3 * 3_600_000, NOW)).toBe('3h ago');
    expect(formatAge(NOW - 2 * 86_400_000, NOW)).toBe('2d ago');
  });

  it('says so when there is nothing to age', () => {
    expect(formatAge(null, NOW)).toBe('no data');
  });

  it('never reports a negative age from a clock skew', () => {
    expect(formatAge(NOW + 5000, NOW)).toBe('just now');
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
