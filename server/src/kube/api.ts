/**
 * The narrow set of cluster questions kubitor asks.
 *
 * Collectors and probes are written against this interface, never against
 * `@kubernetes/client-node`, so every one of them is testable with a fake
 * cluster and no API server.
 */
export interface KubeApi {
  serverVersion(): Promise<string>;
  listNodes(): Promise<NodeInfo[]>;
  listPods(): Promise<PodInfo[]>;
  listNamespaces(): Promise<string[]>;
  /** Events newer than the given epoch-ms instant. */
  listEvents(since: number): Promise<EventInfo[]>;
  /** Raw kubelet `/stats/summary` document for one node. */
  nodeSummary(node: string): Promise<unknown>;

  listIngresses(): Promise<IngressInfo[]>;
  /** Rows from a namespaced custom resource, as plain JSON. */
  listCustomObjects(group: string, version: string, plural: string): Promise<unknown[]>;
  /**
   * The tail of each matching pod's log, kept per pod.
   *
   * Deliberately a tail rather than a time window: `sinceSeconds` is accepted by
   * the client and silently returns nothing, so a caller that trusted it would
   * collect no logs at all while reporting no error.
   */
  podLogTails(namespace: string, labelSelector: string, tailLines: number): Promise<PodLogTail[]>;

  hasCrd(name: string): Promise<boolean>;
  workload(
    kind: 'Deployment' | 'DaemonSet' | 'StatefulSet',
    namespace: string,
    name: string,
  ): Promise<WorkloadRef | null>;
  service(namespace: string, name: string): Promise<boolean>;
  serviceHasReadyEndpoints(namespace: string, name: string): Promise<boolean>;
  ingressClass(name: string): Promise<boolean>;
  storageClassProvisioners(): Promise<string[]>;
}

export interface NodeInfo {
  name: string;
  roles: string[];
  ready: boolean;
  kubeletVersion: string;
  osImage: string;
  architecture: string;
  capacityCpuMilli: number;
  capacityMemoryBytes: number;
  capacityPods: number;
  allocatableCpuMilli: number;
  allocatableMemoryBytes: number;
  allocatablePods: number;
  createdAt: number;
}

export interface PodInfo {
  namespace: string;
  name: string;
  node: string | null;
  phase: string;
  /**
   * Why the pod is not running, from the container that is not running.
   *
   * Null for a pod that is doing what it should. `phase` alone cannot say
   * this: a crash loop and a missing image are both `Pending`.
   */
  reason: string | null;
  ready: boolean;
  restarts: number;
  images: string[];
  ownerKind: string | null;
  ownerName: string | null;
  createdAt: number;
}

export interface EventInfo {
  at: number;
  namespace: string;
  kind: string;
  name: string;
  reason: string;
  message: string;
  type: string;
  count: number;
}

export interface IngressRule {
  host: string;
  path: string;
  service: string;
  port: number | null;
}

export interface IngressInfo {
  namespace: string;
  name: string;
  className: string | null;
  tls: boolean;
  rules: IngressRule[];
}

export interface PodLogTail {
  pod: string;
  lines: string[];
}

export interface WorkloadRef {
  namespace: string;
  name: string;
  version?: string;
  readyReplicas: number;
}

/**
 * Kubernetes reports CPU as strings like `4`, `3800m` or `250n`; memory as
 * `16265732Ki`. Both are normalized here so nothing downstream parses units.
 */
export function parseCpuToMilli(value: string | undefined): number {
  if (!value) return 0;
  if (value.endsWith('n')) return Number(value.slice(0, -1)) / 1_000_000;
  if (value.endsWith('u')) return Number(value.slice(0, -1)) / 1000;
  if (value.endsWith('m')) return Number(value.slice(0, -1));
  return Number(value) * 1000;
}

const MEMORY_SUFFIXES: Record<string, number> = {
  Ki: 1024,
  Mi: 1024 ** 2,
  Gi: 1024 ** 3,
  Ti: 1024 ** 4,
  Pi: 1024 ** 5,
  K: 1000,
  M: 1000 ** 2,
  G: 1000 ** 3,
  T: 1000 ** 4,
  P: 1000 ** 5,
};

export function parseMemoryToBytes(value: string | undefined): number {
  if (!value) return 0;

  for (const [suffix, factor] of Object.entries(MEMORY_SUFFIXES)) {
    if (value.endsWith(suffix)) return Number(value.slice(0, -suffix.length)) * factor;
  }
  return Number(value);
}
