import type { KubeApi } from '../kube/api.js';
import { parseNodeSummary } from '../kube/summary.js';
import type { Collector, Emission, IntegrationModule } from '../plugins/contract.js';

/** How often the cluster shape is re-read. */
const STATE_INTERVAL_MS = 15_000;
/**
 * How often the kubelet is asked for metrics.
 *
 * Not how often they are stored, and not how often they are pushed: those are
 * three different rates. Five seconds is the honest floor here — cAdvisor's
 * housekeeping means a faster poll returns the same numbers with more load on
 * the API server. Genuine per-second values come from the agent, which reads
 * `/proc` directly.
 */
const SAMPLE_INTERVAL_MS = 5_000;
const EVENT_INTERVAL_MS = 30_000;

/**
 * The integration that is always present.
 *
 * It needs nothing installed in the cluster beyond kubitor's own read
 * permissions, which is what makes bare k3s a first-class target rather than a
 * degraded one.
 */
export function coreIntegration(api: KubeApi, sampleSink: NodeSampleSink): IntegrationModule {
  let lastEventSweep = 0;

  return {
    id: 'core',
    title: 'Kubernetes',
    scope: 'cluster',
    facets: ['nodes', 'workloads', 'events'],
    requiredRbac: [
      {
        apiGroups: [''],
        resources: ['nodes', 'pods', 'namespaces', 'events', 'services', 'endpoints'],
        verbs: ['get', 'list'],
      },
      { apiGroups: [''], resources: ['nodes/proxy'], verbs: ['get'] },
      {
        apiGroups: ['apps'],
        resources: ['deployments', 'daemonsets', 'statefulsets'],
        verbs: ['get', 'list'],
      },
    ],

    async detect() {
      const version = await api.serverVersion();
      return { state: 'present', version, evidence: `Kubernetes API server ${version}` };
    },

    collectors(): readonly Collector[] {
      return [
        {
          kind: 'poll',
          id: 'core-nodes',
          intervalMs: STATE_INTERVAL_MS,
          async run(ctx): Promise<Emission[]> {
            const nodes = await api.listNodes();
            const observedAt = ctx.now();

            return [
              {
                facet: 'nodes',
                rows: nodes.map((node) => ({
                  observed_at: observedAt,
                  name: node.name,
                  roles: node.roles.join(','),
                  ready: node.ready ? 1 : 0,
                  kubelet_version: node.kubeletVersion,
                  os_image: node.osImage,
                  architecture: node.architecture,
                  capacity_cpu_milli: Math.round(node.capacityCpuMilli),
                  capacity_memory_bytes: node.capacityMemoryBytes,
                  capacity_pods: node.capacityPods,
                  allocatable_cpu_milli: Math.round(node.allocatableCpuMilli),
                  allocatable_memory_bytes: node.allocatableMemoryBytes,
                  allocatable_pods: node.allocatablePods,
                  created_at: node.createdAt,
                  attrs: {},
                })),
              },
            ];
          },
        },

        {
          kind: 'poll',
          id: 'core-workloads',
          intervalMs: STATE_INTERVAL_MS,
          async run(ctx): Promise<Emission[]> {
            const pods = await api.listPods();
            const observedAt = ctx.now();

            return [
              {
                facet: 'workloads',
                rows: pods.map((pod) => ({
                  observed_at: observedAt,
                  namespace: pod.namespace,
                  name: pod.name,
                  kind: 'Pod',
                  node: pod.node,
                  phase: pod.phase,
                  reason: pod.reason,
                  ready: pod.ready ? 1 : 0,
                  restarts: pod.restarts,
                  images: pod.images.join(','),
                  owner_kind: pod.ownerKind,
                  owner_name: pod.ownerName,
                  created_at: pod.createdAt,
                  attrs: {},
                })),
              },
            ];
          },
        },

        {
          kind: 'poll',
          id: 'core-events',
          intervalMs: EVENT_INTERVAL_MS,
          async run(ctx): Promise<Emission[]> {
            const now = ctx.now();
            // Only what is new since the last sweep; events are an append-only
            // facet and re-sending the whole list would duplicate every row.
            const since = lastEventSweep || now - EVENT_INTERVAL_MS;
            const events = await api.listEvents(since);
            lastEventSweep = now;

            return [
              {
                facet: 'events',
                rows: events.map((event) => ({
                  at: event.at,
                  namespace: event.namespace,
                  kind: event.kind,
                  name: event.name,
                  reason: event.reason,
                  message: event.message,
                  type: event.type,
                  count: event.count,
                  attrs: {},
                })),
              },
            ];
          },
        },

        {
          kind: 'poll',
          id: 'core-node-samples',
          intervalMs: SAMPLE_INTERVAL_MS,
          async run(ctx): Promise<Emission[]> {
            const nodes = await api.listNodes();
            const fallbackAt = ctx.now();

            // One unreachable kubelet must not cost the other nodes their
            // sample, so each is settled independently.
            const results = await Promise.allSettled(
              nodes.map(async (node) => {
                const document = await api.nodeSummary(node.name);
                return parseNodeSummary(document, fallbackAt);
              }),
            );

            for (const result of results) {
              if (result.status === 'fulfilled' && result.value) {
                await sampleSink(result.value);
              }
            }

            // Samples go to their own store rather than through the facet
            // pipeline: they are a time series, not a snapshot.
            return [];
          },
        },
      ];
    },
  };
}

export type NodeSampleSink = (sample: import('../kube/summary.js').NodeSample) => Promise<void>;
