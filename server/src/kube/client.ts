import {
  ApiException,
  ApiextensionsV1Api,
  AppsV1Api,
  CoreV1Api,
  CustomObjectsApi,
  KubeConfig,
  NetworkingV1Api,
  StorageV1Api,
  VersionApi,
} from '@kubernetes/client-node';
import { ProbeDeniedError } from '../plugins/contract.js';
import {
  type EventInfo,
  type IngressInfo,
  type KubeApi,
  type NodeInfo,
  type PodInfo,
  parseCpuToMilli,
  parseMemoryToBytes,
  type WorkloadRef,
} from './api.js';

/**
 * `KubeApi` over `@kubernetes/client-node`.
 *
 * Error mapping is the interesting part: a 403 becomes `ProbeDeniedError` so
 * detection can report `unknown`, and a 404 becomes "not there". Anything else
 * propagates, because an unreachable API server is not the same as an empty
 * cluster and must not be reported as one.
 */
export class KubeClient implements KubeApi {
  readonly #core: CoreV1Api;
  readonly #apps: AppsV1Api;
  readonly #crds: ApiextensionsV1Api;
  readonly #storage: StorageV1Api;
  readonly #networking: NetworkingV1Api;
  readonly #version: VersionApi;
  readonly #custom: CustomObjectsApi;

  constructor(config: KubeConfig) {
    this.#core = config.makeApiClient(CoreV1Api);
    this.#apps = config.makeApiClient(AppsV1Api);
    this.#crds = config.makeApiClient(ApiextensionsV1Api);
    this.#storage = config.makeApiClient(StorageV1Api);
    this.#networking = config.makeApiClient(NetworkingV1Api);
    this.#version = config.makeApiClient(VersionApi);
    this.#custom = config.makeApiClient(CustomObjectsApi);
  }

  static fromCluster(): KubeClient {
    const config = new KubeConfig();
    // In a pod this reads the service account; outside it reads ~/.kube/config.
    config.loadFromDefault();
    return new KubeClient(config);
  }

  async serverVersion(): Promise<string> {
    const info = await this.#version.getCode();
    return info.gitVersion ?? 'unknown';
  }

  async listNodes(): Promise<NodeInfo[]> {
    const list = await guard(() => this.#core.listNode());

    return (list?.items ?? []).map((node) => {
      const status = node.status ?? {};
      const ready = (status.conditions ?? []).find((c) => c.type === 'Ready')?.status === 'True';
      const labels = node.metadata?.labels ?? {};

      return {
        name: node.metadata?.name ?? '',
        roles: Object.keys(labels)
          .filter((key) => key.startsWith('node-role.kubernetes.io/'))
          .map((key) => key.slice('node-role.kubernetes.io/'.length))
          .filter((role) => role.length > 0),
        ready,
        kubeletVersion: status.nodeInfo?.kubeletVersion ?? 'unknown',
        osImage: status.nodeInfo?.osImage ?? 'unknown',
        architecture: status.nodeInfo?.architecture ?? 'unknown',
        capacityCpuMilli: parseCpuToMilli(status.capacity?.cpu),
        capacityMemoryBytes: parseMemoryToBytes(status.capacity?.memory),
        capacityPods: Number(status.capacity?.pods ?? 0),
        allocatableCpuMilli: parseCpuToMilli(status.allocatable?.cpu),
        allocatableMemoryBytes: parseMemoryToBytes(status.allocatable?.memory),
        allocatablePods: Number(status.allocatable?.pods ?? 0),
        createdAt: toEpoch(node.metadata?.creationTimestamp),
      };
    });
  }

  async listPods(): Promise<PodInfo[]> {
    const list = await guard(() => this.#core.listPodForAllNamespaces());

    return (list?.items ?? []).map((pod) => {
      const statuses = pod.status?.containerStatuses ?? [];
      const owner = (pod.metadata?.ownerReferences ?? [])[0];

      return {
        namespace: pod.metadata?.namespace ?? '',
        name: pod.metadata?.name ?? '',
        node: pod.spec?.nodeName ?? null,
        phase: pod.status?.phase ?? 'Unknown',
        ready: statuses.length > 0 && statuses.every((status) => status.ready),
        restarts: statuses.reduce((total, status) => total + (status.restartCount ?? 0), 0),
        images: (pod.spec?.containers ?? []).map((container) => container.image ?? ''),
        ownerKind: owner?.kind ?? null,
        ownerName: owner?.name ?? null,
        createdAt: toEpoch(pod.metadata?.creationTimestamp),
      };
    });
  }

  async listNamespaces(): Promise<string[]> {
    const list = await guard(() => this.#core.listNamespace());
    return (list?.items ?? []).map((namespace) => namespace.metadata?.name ?? '');
  }

  async listEvents(since: number): Promise<EventInfo[]> {
    const list = await guard(() => this.#core.listEventForAllNamespaces());

    return (list?.items ?? [])
      .map((event) => ({
        at: toEpoch(event.lastTimestamp ?? event.eventTime ?? event.metadata?.creationTimestamp),
        namespace: event.metadata?.namespace ?? '',
        kind: event.involvedObject?.kind ?? '',
        name: event.involvedObject?.name ?? '',
        reason: event.reason ?? '',
        message: event.message ?? '',
        type: event.type ?? 'Normal',
        count: event.count ?? 1,
      }))
      .filter((event) => event.at > since);
  }

  async nodeSummary(node: string): Promise<unknown> {
    // The client already parses the JSON body for us.
    return this.#core.connectGetNodeProxyWithPath({ name: node, path: 'stats/summary' });
  }

  async listIngresses(): Promise<IngressInfo[]> {
    const list = await guard(() => this.#networking.listIngressForAllNamespaces());

    return (list?.items ?? []).map((ingress) => ({
      namespace: ingress.metadata?.namespace ?? '',
      name: ingress.metadata?.name ?? '',
      className: ingress.spec?.ingressClassName ?? null,
      tls: (ingress.spec?.tls ?? []).length > 0,
      rules: (ingress.spec?.rules ?? []).flatMap((rule) =>
        (rule.http?.paths ?? []).map((httpPath) => ({
          host: rule.host ?? '*',
          path: httpPath.path ?? '/',
          service: httpPath.backend?.service?.name ?? '',
          port: httpPath.backend?.service?.port?.number ?? null,
        })),
      ),
    }));
  }

  async listCustomObjects(group: string, version: string, plural: string): Promise<unknown[]> {
    const list = await optional(() =>
      this.#custom.listCustomObjectForAllNamespaces({ group, version, resourcePlural: plural }),
    );

    const items = (list as { items?: unknown[] } | null)?.items;
    return Array.isArray(items) ? items : [];
  }

  async podLogsSince(
    namespace: string,
    labelSelector: string,
    sinceSeconds: number,
  ): Promise<string[]> {
    const pods = await guard(() => this.#core.listNamespacedPod({ namespace, labelSelector }));

    const lines: string[] = [];
    for (const pod of pods?.items ?? []) {
      const name = pod.metadata?.name;
      if (!name) continue;

      // Read a bounded window rather than holding a stream open. A stream that
      // fails mid-flight looks identical to a quiet one, and a wedged stream
      // silently stops the facet; a failed poll is a visible collector error.
      const text = await optional(() =>
        this.#core.readNamespacedPodLog({ namespace, name, sinceSeconds, timestamps: false }),
      );

      if (typeof text === 'string') lines.push(...text.split('\n'));
    }
    return lines;
  }

  async hasCrd(name: string): Promise<boolean> {
    const crd = await optional(() => this.#crds.readCustomResourceDefinition({ name }));
    return crd !== null;
  }

  async workload(
    kind: 'Deployment' | 'DaemonSet' | 'StatefulSet',
    namespace: string,
    name: string,
  ): Promise<WorkloadRef | null> {
    const read =
      kind === 'Deployment'
        ? () => this.#apps.readNamespacedDeployment({ namespace, name })
        : kind === 'DaemonSet'
          ? () => this.#apps.readNamespacedDaemonSet({ namespace, name })
          : () => this.#apps.readNamespacedStatefulSet({ namespace, name });

    const workload = await optional(read);
    if (!workload) return null;

    const image = workload.spec?.template?.spec?.containers?.[0]?.image;
    const version = image?.includes(':') ? image.slice(image.lastIndexOf(':') + 1) : undefined;

    return {
      namespace,
      name,
      readyReplicas:
        (workload.status as { readyReplicas?: number; numberReady?: number } | undefined)
          ?.readyReplicas ??
        (workload.status as { numberReady?: number } | undefined)?.numberReady ??
        0,
      ...(version ? { version } : {}),
    };
  }

  async service(namespace: string, name: string): Promise<boolean> {
    return (await optional(() => this.#core.readNamespacedService({ namespace, name }))) !== null;
  }

  async serviceHasReadyEndpoints(namespace: string, name: string): Promise<boolean> {
    const endpoints = await optional(() =>
      this.#core.listNamespacedEndpoints({ namespace, fieldSelector: `metadata.name=${name}` }),
    );

    const subsets = endpoints?.items?.[0]?.subsets ?? [];
    return subsets.some((subset) => (subset.addresses ?? []).length > 0);
  }

  async ingressClass(name: string): Promise<boolean> {
    return (await optional(() => this.#networking.readIngressClass({ name }))) !== null;
  }

  async storageClassProvisioners(): Promise<string[]> {
    const list = await guard(() => this.#storage.listStorageClass());
    return (list?.items ?? []).map((storageClass) => storageClass.provisioner);
  }
}

function statusOf(error: unknown): number | undefined {
  return error instanceof ApiException ? error.code : undefined;
}

/** Turns "not allowed to look" into the error detection knows how to report. */
async function guard<T>(call: () => Promise<T>): Promise<T | null> {
  try {
    return await call();
  } catch (error) {
    if (statusOf(error) === 403) throw new ProbeDeniedError(describe(error));
    throw error;
  }
}

/** Like `guard`, but a 404 means "not there" rather than a failure. */
async function optional<T>(call: () => Promise<T>): Promise<T | null> {
  try {
    return await call();
  } catch (error) {
    const status = statusOf(error);
    if (status === 404) return null;
    if (status === 403) throw new ProbeDeniedError(describe(error));
    throw error;
  }
}

function describe(error: unknown): string {
  return error instanceof ApiException ? (error.body ?? 'the resource') : 'the resource';
}

function toEpoch(value: Date | string | undefined): number {
  if (!value) return 0;
  const parsed = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}
