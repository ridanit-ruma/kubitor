import { describe, expect, it } from 'vitest';
import { parseCpuToMilli, parseMemoryToBytes } from './api.js';
import { counterRate, percentOf } from './rates.js';
import { parseNodeSummary } from './summary.js';

const FALLBACK = 1_756_800_000_000;

/** Shaped after a real kubelet /stats/summary response. */
const summary = {
  node: {
    nodeName: 'ken',
    cpu: { time: '2026-09-03T03:00:00Z', usageNanoCores: 421_000_000 },
    memory: { time: '2026-09-03T03:00:00Z', workingSetBytes: 3_221_225_472 },
    fs: { usedBytes: 20_000_000_000, capacityBytes: 100_000_000_000 },
    network: {
      name: 'eth0',
      rxBytes: 900,
      txBytes: 800,
      interfaces: [
        { name: 'eth0', rxBytes: 1000, txBytes: 2000 },
        { name: 'lo', rxBytes: 5, txBytes: 5 },
        { name: 'cilium_host', rxBytes: 999_999, txBytes: 999_999 },
        { name: 'lxc1234', rxBytes: 42, txBytes: 42 },
        { name: 'wlan0', rxBytes: 500, txBytes: 300 },
      ],
    },
  },
};

describe('parseNodeSummary', () => {
  it('reads the node gauges', () => {
    const sample = parseNodeSummary(summary, FALLBACK);

    expect(sample?.node).toBe('ken');
    expect(sample?.cpuNanoCores).toBe(421_000_000);
    expect(sample?.memoryWorkingSetBytes).toBe(3_221_225_472);
    expect(sample?.fsUsedBytes).toBe(20_000_000_000);
  });

  it('uses the kubelet timestamp rather than the moment we asked', () => {
    expect(parseNodeSummary(summary, FALLBACK)?.at).toBe(Date.parse('2026-09-03T03:00:00Z'));
  });

  /**
   * Virtual interfaces carry the same packets as the physical ones they bridge.
   * Summing everything would report several times the real traffic.
   */
  it('sums physical interfaces only', () => {
    const sample = parseNodeSummary(summary, FALLBACK);

    expect(sample?.networkRxBytes).toBe(1500);
    expect(sample?.networkTxBytes).toBe(2300);
  });

  /**
   * Interface names captured from a real Cilium cluster's kubelet. Two physical
   * NICs and a wireless one carry the traffic; `cilium_*` and twenty-odd `lxc*`
   * pod veths carry the same packets a second time.
   */
  it('keeps real NIC names and rejects the pod veths beside them', () => {
    const real = {
      node: {
        nodeName: 'ken',
        network: {
          name: '',
          interfaces: [
            { name: 'enp3s0', rxBytes: 6_286_335_941, txBytes: 10_418_767_965 },
            { name: 'enp4s0', rxBytes: 28_499_337_953, txBytes: 22_719_041_423 },
            { name: 'wlo1', rxBytes: 0, txBytes: 0 },
            { name: 'cilium_net', rxBytes: 23_858, txBytes: 6380 },
            { name: 'cilium_host', rxBytes: 6380, txBytes: 23_858 },
            { name: 'lxc_health', rxBytes: 7_775_099, txBytes: 9_398_647 },
            { name: 'lxc355037eb2bbd', rxBytes: 18_152_724_990, txBytes: 17_634_189_710 },
          ],
        },
      },
    };

    const sample = parseNodeSummary(real, FALLBACK);

    expect(sample?.networkRxBytes).toBe(6_286_335_941 + 28_499_337_953);
    expect(sample?.networkTxBytes).toBe(10_418_767_965 + 22_719_041_423);
  });

  it('falls back to the default interface when no list is given', () => {
    const withoutList = {
      node: { ...summary.node, network: { rxBytes: 7, txBytes: 8 } },
    };

    const sample = parseNodeSummary(withoutList, FALLBACK);
    expect(sample?.networkRxBytes).toBe(7);
    expect(sample?.networkTxBytes).toBe(8);
  });

  it('degrades a missing field to null rather than losing the node', () => {
    const sample = parseNodeSummary({ node: { nodeName: 'bare' } }, FALLBACK);

    expect(sample?.node).toBe('bare');
    expect(sample?.at).toBe(FALLBACK);
    expect(sample?.cpuNanoCores).toBeNull();
    expect(sample?.memoryWorkingSetBytes).toBeNull();
    expect(sample?.networkRxBytes).toBeNull();
  });

  it('returns null for a document that is not a summary', () => {
    for (const bad of [null, undefined, {}, 'text', { node: {} }]) {
      expect(parseNodeSummary(bad, FALLBACK)).toBeNull();
    }
  });
});

describe('counterRate', () => {
  it('converts a delta into a per-second rate', () => {
    expect(counterRate({ at: 0, value: 100 }, { at: 10_000, value: 600 })).toBe(50);
  });

  it('has no rate for the first reading', () => {
    expect(counterRate(undefined, { at: 0, value: 100 })).toBeNull();
  });

  /** A restarted interface resets its counter; a negative rate would be a lie. */
  it('drops a counter reset instead of reporting negative traffic', () => {
    expect(counterRate({ at: 0, value: 1_000_000 }, { at: 10_000, value: 5 })).toBeNull();
  });

  it('has no rate when no time passed', () => {
    expect(counterRate({ at: 5000, value: 1 }, { at: 5000, value: 9 })).toBeNull();
    expect(counterRate({ at: 5000, value: 1 }, { at: 4000, value: 9 })).toBeNull();
  });
});

describe('percentOf', () => {
  it('computes a percentage of real capacity', () => {
    expect(percentOf(25, 200)).toBe(12.5);
  });

  it('returns null rather than NaN or Infinity', () => {
    expect(percentOf(1, 0)).toBeNull();
    expect(percentOf(null, 100)).toBeNull();
    expect(percentOf(1, null)).toBeNull();
  });

  it('clamps to the 0-100 range', () => {
    expect(percentOf(300, 100)).toBe(100);
    expect(percentOf(-5, 100)).toBe(0);
  });
});

describe('quantity parsing', () => {
  it('normalizes every CPU form kubernetes emits', () => {
    expect(parseCpuToMilli('4')).toBe(4000);
    expect(parseCpuToMilli('3800m')).toBe(3800);
    expect(parseCpuToMilli('250000000n')).toBe(250);
    expect(parseCpuToMilli(undefined)).toBe(0);
  });

  it('normalizes binary and decimal memory suffixes', () => {
    expect(parseMemoryToBytes('1Ki')).toBe(1024);
    expect(parseMemoryToBytes('16265732Ki')).toBe(16_656_109_568);
    expect(parseMemoryToBytes('2Gi')).toBe(2_147_483_648);
    expect(parseMemoryToBytes('1M')).toBe(1_000_000);
    expect(parseMemoryToBytes('512')).toBe(512);
    expect(parseMemoryToBytes(undefined)).toBe(0);
  });
});
