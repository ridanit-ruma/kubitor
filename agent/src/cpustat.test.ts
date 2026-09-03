import { describe, expect, it } from 'vitest';
import { parseCpuTimes, utilization } from './cpustat.js';

const STAT = [
  'cpu  10000 200 3000 80000 500 0 100 0 0 0',
  'cpu0 2500 50 750 20000 125 0 25 0 0 0',
  'intr 12345',
].join('\n');

describe('parseCpuTimes', () => {
  it('reads the aggregate line', () => {
    expect(parseCpuTimes(STAT)).toEqual({ total: 93_800, idle: 80_500 });
  });

  /**
   * A core waiting on a slow disk was available to run something. Counting
   * iowait as busy makes an idle machine look saturated.
   */
  it('counts iowait as idle', () => {
    const times = parseCpuTimes('cpu 0 0 0 100 400 0 0 0 0 0');
    expect(times?.idle).toBe(500);
  });

  it('returns null for a file it cannot make sense of', () => {
    expect(parseCpuTimes('intr 1')).toBeNull();
    expect(parseCpuTimes('cpu a b c')).toBeNull();
  });
});

describe('utilization', () => {
  it('reports the busy share of the interval', () => {
    const previous = { total: 1000, idle: 900 };
    const current = { total: 1100, idle: 950 };
    expect(utilization(previous, current)).toBe(50);
  });

  it('has nothing to report on the first reading', () => {
    expect(utilization(null, { total: 1000, idle: 900 })).toBeNull();
  });

  it('refuses a counter that went backwards', () => {
    // A reboot, or two reads inside one jiffy. Neither is a measurement.
    expect(utilization({ total: 2000, idle: 1000 }, { total: 1000, idle: 500 })).toBeNull();
    expect(utilization({ total: 1000, idle: 500 }, { total: 1000, idle: 500 })).toBeNull();
  });

  it('never leaves the zero to one hundred range', () => {
    const percent = utilization({ total: 0, idle: 0 }, { total: 100, idle: 0 });
    expect(percent).toBe(100);
  });
});
