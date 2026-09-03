/**
 * kubelet `/stats/summary` is the only metrics source kubitor needs, and it is
 * available on every cluster without installing anything — which is the whole
 * point of not requiring Prometheus.
 *
 * Parsing is deliberately forgiving: a field the kubelet did not report becomes
 * null rather than throwing, because losing one gauge should not lose the node.
 */
export interface NodeSample {
  node: string;
  /** Instant the kubelet reported, not the instant kubitor asked. */
  at: number;
  cpuNanoCores: number | null;
  memoryWorkingSetBytes: number | null;
  fsUsedBytes: number | null;
  fsCapacityBytes: number | null;
  /** Cumulative counters. Convert with `counterRate` before display. */
  networkRxBytes: number | null;
  networkTxBytes: number | null;
}

interface RawInterface {
  name?: unknown;
  rxBytes?: unknown;
  txBytes?: unknown;
}

export function parseNodeSummary(document: unknown, fallbackAt: number): NodeSample | null {
  const node = pick(document, 'node');
  if (!isRecord(node)) return null;

  const name = typeof node.nodeName === 'string' ? node.nodeName : null;
  if (!name) return null;

  const cpu = pick(node, 'cpu');
  const memory = pick(node, 'memory');
  const fs = pick(node, 'fs');
  const network = pick(node, 'network');

  return {
    node: name,
    at: timestamp(cpu) ?? timestamp(memory) ?? fallbackAt,
    cpuNanoCores: numberAt(cpu, 'usageNanoCores'),
    memoryWorkingSetBytes: numberAt(memory, 'workingSetBytes'),
    fsUsedBytes: numberAt(fs, 'usedBytes'),
    fsCapacityBytes: numberAt(fs, 'capacityBytes'),
    ...physicalNetwork(network),
  };
}

/**
 * Sums only physical interfaces.
 *
 * The kubelet reports the node's default interface at the top level and every
 * interface it can see underneath, including veth pairs and CNI bridges.
 * Adding those would double-count every packet that crosses a pod boundary.
 */
function physicalNetwork(network: unknown): {
  networkRxBytes: number | null;
  networkTxBytes: number | null;
} {
  if (!isRecord(network)) return { networkRxBytes: null, networkTxBytes: null };

  const interfaces = Array.isArray(network.interfaces)
    ? (network.interfaces as RawInterface[])
    : [];

  const physical = interfaces.filter(
    (candidate) => typeof candidate.name === 'string' && isPhysical(candidate.name),
  );

  if (physical.length === 0) {
    // No usable interface list; fall back to the node's default interface.
    return {
      networkRxBytes: numberAt(network, 'rxBytes'),
      networkTxBytes: numberAt(network, 'txBytes'),
    };
  }

  let rx = 0;
  let tx = 0;
  for (const candidate of physical) {
    rx += typeof candidate.rxBytes === 'number' ? candidate.rxBytes : 0;
    tx += typeof candidate.txBytes === 'number' ? candidate.txBytes : 0;
  }
  return { networkRxBytes: rx, networkTxBytes: tx };
}

/**
 * Interface names that carry traffic already counted elsewhere.
 *
 * `lxc` matters most here: Cilium names every pod's host-side veth `lxc<hash>`,
 * so a cluster running Cilium would report several times its real traffic if
 * these were summed. `cali` is Calico's equivalent.
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

function isPhysical(name: string): boolean {
  return !VIRTUAL_PREFIXES.some((prefix) => name.startsWith(prefix));
}

function timestamp(value: unknown): number | null {
  if (!isRecord(value) || typeof value.time !== 'string') return null;
  const parsed = Date.parse(value.time);
  return Number.isNaN(parsed) ? null : parsed;
}

function numberAt(value: unknown, key: string): number | null {
  if (!isRecord(value)) return null;
  const candidate = value[key];
  return typeof candidate === 'number' && Number.isFinite(candidate) ? candidate : null;
}

function pick(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
