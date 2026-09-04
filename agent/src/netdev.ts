import { readFile } from 'node:fs/promises';

/**
 * The host's interface counters.
 *
 * `/proc/net/dev` is per network namespace, so inside a pod it describes the
 * pod: one loopback and one veth. The host's init process sees the machine's
 * real interfaces, which is what a node screen is about.
 */
const HOST_NET_DEV = '/host/net/dev';
const NET_CLASS = '/host/sys/class/net';

export interface InterfaceCounters {
  name: string;
  rxBytes: number;
  txBytes: number;
  rxPackets: number;
  txPackets: number;
  rxErrors: number;
  txErrors: number;
  rxDropped: number;
  txDropped: number;
}

export interface InterfaceReading extends InterfaceCounters {
  /** Negotiated link speed in megabits per second, where the driver reports one. */
  speedMbps: number | null;
  mtu: number | null;
  state: string | null;
  macAddress: string | null;
  rxBytesPerSecond: number | null;
  txBytesPerSecond: number | null;
}

/**
 * Interface names whose traffic is already counted elsewhere.
 *
 * `lxc` matters most: Cilium names every pod's host-side veth `lxc<hash>`, so
 * summing them would report several times the machine's real traffic. `cali` is
 * Calico's equivalent.
 */
const VIRTUAL_PREFIXES = [
  'lo',
  'veth',
  'lxc',
  'cali',
  'cni',
  'flannel',
  'cilium',
  'docker',
  'br-',
  'virbr',
  'kube',
  'vxlan',
  'tun',
  'tap',
  'dummy',
  'nodelocal',
];

export function isPhysical(name: string): boolean {
  return !VIRTUAL_PREFIXES.some((prefix) => name.startsWith(prefix));
}

export function parseNetDev(text: string): InterfaceCounters[] {
  const counters: InterfaceCounters[] = [];

  for (const line of text.split('\n')) {
    const separator = line.indexOf(':');
    if (separator === -1) continue;

    const name = line.slice(0, separator).trim();
    const fields = line
      .slice(separator + 1)
      .trim()
      .split(/\s+/)
      .map(Number);

    // Receive takes eight columns, transmit the next eight.
    if (
      name.length === 0 ||
      fields.length < 16 ||
      fields.some((value) => !Number.isFinite(value))
    ) {
      continue;
    }

    counters.push({
      name,
      rxBytes: fields[0] ?? 0,
      rxPackets: fields[1] ?? 0,
      rxErrors: fields[2] ?? 0,
      rxDropped: fields[3] ?? 0,
      txBytes: fields[8] ?? 0,
      txPackets: fields[9] ?? 0,
      txErrors: fields[10] ?? 0,
      txDropped: fields[11] ?? 0,
    });
  }

  return counters;
}

/** Bytes per second between two counter readings, or null across a reset. */
export function rate(previous: number, current: number, elapsedMs: number): number | null {
  if (elapsedMs <= 0) return null;
  // A counter that went backwards is an interface that was reset, not traffic.
  if (current < previous) return null;
  return ((current - previous) / elapsedMs) * 1000;
}

/**
 * Per-interface throughput, measured between calls.
 *
 * The kubelet reports the same counters but only re-reads them every few
 * seconds, so a rate derived from it moves in steps. Reading them here makes
 * the figure move at the rate the dashboard claims it does.
 */
export function createNetworkMeter(devPath = HOST_NET_DEV, classPath = NET_CLASS) {
  let previous = new Map<string, InterfaceCounters>();
  let previousAt = 0;

  return async function measure(now: number): Promise<InterfaceReading[]> {
    let text: string;
    try {
      text = await readFile(devPath, 'utf8');
    } catch {
      return [];
    }

    const elapsed = previousAt === 0 ? 0 : now - previousAt;
    const readings: InterfaceReading[] = [];

    for (const counters of parseNetDev(text)) {
      if (!isPhysical(counters.name)) continue;

      const before = previous.get(counters.name);
      readings.push({
        ...counters,
        ...(await link(classPath, counters.name)),
        rxBytesPerSecond: before ? rate(before.rxBytes, counters.rxBytes, elapsed) : null,
        txBytesPerSecond: before ? rate(before.txBytes, counters.txBytes, elapsed) : null,
      });
    }

    previous = new Map(parseNetDev(text).map((counters) => [counters.name, counters]));
    previousAt = now;

    return readings.sort((a, b) => a.name.localeCompare(b.name));
  };
}

async function link(
  root: string,
  name: string,
): Promise<Pick<InterfaceReading, 'speedMbps' | 'mtu' | 'state' | 'macAddress'>> {
  const [speed, mtu, state, mac] = await Promise.all([
    maybeRead(`${root}/${name}/speed`),
    maybeRead(`${root}/${name}/mtu`),
    maybeRead(`${root}/${name}/operstate`),
    maybeRead(`${root}/${name}/address`),
  ]);

  return {
    // A down or virtual interface answers -1, which is not a speed.
    speedMbps: positive(speed),
    mtu: positive(mtu),
    state: state?.trim() ?? null,
    macAddress: mac?.trim() ?? null,
  };
}

function positive(raw: string | null): number | null {
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
