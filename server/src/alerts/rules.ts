import type { AlertRule, World } from './rule.js';

/**
 * States a pod passes through on its way to running.
 *
 * Every rollout goes through them. A rule that fired on these would page
 * somebody on every deploy, which is how a channel becomes one nobody reads.
 */
const BENIGN_REASONS = new Set(['ContainerCreating', 'PodInitializing']);

/**
 * The first rules, deliberately few.
 *
 * Each one is a condition an operator would act on, drawn from data that
 * already exists, and each has an obvious recovery. A rule that cannot express
 * what "better" looks like is not ready to be a rule: a channel that only ever
 * reports bad news trains people to ignore it, because they cannot tell an
 * outage from its aftermath.
 */
export const CORE_RULES: readonly AlertRule[] = [
  {
    id: 'node-not-ready',
    title: 'Node not ready',
    severity: 'critical',
    // Two evaluations, because a kubelet restart briefly shows not-ready and
    // recovers on its own.
    fireAfter: 2,
    resolveAfter: 1,
    observe: (world) =>
      world.nodes
        .filter((node) => node.ready !== 1)
        .map((node) => ({
          subject: node.name,
          summary: `Node ${node.name} is not ready`,
          detail: 'The kubelet has stopped reporting itself as ready. Pods on it will be evicted.',
        })),
  },

  {
    id: 'pod-crashloop',
    title: 'Pod in CrashLoopBackOff',
    severity: 'warning',
    fireAfter: 2,
    resolveAfter: 2,
    observe: (world) =>
      world.pods
        .filter((pod) => pod.reason === 'CrashLoopBackOff')
        .map((pod) => ({
          subject: `${pod.namespace}/${pod.name}`,
          summary: `${pod.namespace}/${pod.name} is crash-looping`,
          detail: `Restarted ${pod.restarts} times. The container exits and Kubernetes keeps restarting it, with a growing delay.`,
          attrs: { namespace: pod.namespace, pod: pod.name, restarts: pod.restarts },
        })),
  },

  {
    id: 'pod-unschedulable',
    title: 'Pod cannot be placed',
    severity: 'warning',
    // Scheduling is retried constantly, so one evaluation is a real state
    // rather than a race; two avoids firing during a rollout's brief gap.
    fireAfter: 2,
    resolveAfter: 1,
    observe: (world) =>
      world.pods
        .filter((pod) => pod.reason === 'Unschedulable')
        .map((pod) => ({
          subject: `${pod.namespace}/${pod.name}`,
          summary: `${pod.namespace}/${pod.name} cannot be scheduled`,
          detail: 'No node satisfies its requests, affinities or taints.',
          attrs: { namespace: pod.namespace, pod: pod.name },
        })),
  },

  {
    id: 'pod-image-pull',
    title: 'Pod cannot pull its image',
    severity: 'warning',
    fireAfter: 2,
    resolveAfter: 1,
    observe: (world) =>
      world.pods
        .filter(
          (pod) =>
            pod.reason !== null &&
            !BENIGN_REASONS.has(pod.reason) &&
            /ImagePull|ErrImage|InvalidImageName/.test(pod.reason),
        )
        .map((pod) => ({
          subject: `${pod.namespace}/${pod.name}`,
          summary: `${pod.namespace}/${pod.name} cannot pull its image`,
          detail: `Kubernetes reports ${pod.reason}. Usually a wrong tag or a missing pull secret.`,
          attrs: { namespace: pod.namespace, pod: pod.name, reason: pod.reason },
        })),
  },

  /*
   * kubitor watching itself, which is most of what an operator wants from it.
   */
  {
    id: 'agent-silent',
    title: 'Agent stopped reporting',
    severity: 'warning',
    fireAfter: 2,
    resolveAfter: 1,
    observe: (world) =>
      world.staleAgents.map((host) => ({
        subject: host,
        summary: `No host readings from ${host}`,
        detail:
          'The machine has a credential and has stopped reporting. Its clocks, memory, disks and temperatures are unavailable; the cluster view is unaffected.',
      })),
  },

  {
    id: 'backup-failed',
    title: 'Backup failed',
    severity: 'critical',
    // One is enough. A backup runs on a schedule, not a loop, so waiting for a
    // second failure means waiting a day to be told about the first.
    fireAfter: 1,
    resolveAfter: 1,
    observe: (world) => {
      const backup = world.lastBackup;
      if (!backup || backup.ok) return [];

      return [
        {
          subject: 'backup',
          summary: 'The last backup did not complete',
          detail: backup.error ?? 'No reason was recorded.',
          attrs: { startedAt: backup.startedAt },
        },
      ];
    },
  },
];

/** Rules by id, for turning a stored alert back into what produced it. */
export const RULES_BY_ID = new Map(CORE_RULES.map((rule) => [rule.id, rule]));

export function observeAll(
  world: World,
): { rule: AlertRule; observations: ReturnType<AlertRule['observe']> }[] {
  return CORE_RULES.map((rule) => ({ rule, observations: rule.observe(world) }));
}
