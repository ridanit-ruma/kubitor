import { beforeAll, expect, it } from 'vitest';
import { migrateToLatest } from '../db/migrate.js';
import { describeEachDialect } from '../test/db-harness.js';
import { clusterSummary, WARNING_WINDOW_MS } from './cluster-summary.js';

const NOW = 1_756_800_000_000;

interface Pod {
  name: string;
  phase: string;
  ready: number;
  reason?: string | null;
}

/** The mix a real cluster shows: mostly fine, a few things not. */
const PODS: Pod[] = [
  { name: 'web-1', phase: 'Running', ready: 1 },
  { name: 'web-2', phase: 'Running', ready: 1 },
  // Running and not serving — the state a phase count hides.
  { name: 'web-3', phase: 'Running', ready: 0 },
  { name: 'job-1', phase: 'Succeeded', ready: 0 },
  { name: 'api-1', phase: 'Pending', ready: 0, reason: 'CrashLoopBackOff' },
  { name: 'api-2', phase: 'Pending', ready: 0, reason: 'CrashLoopBackOff' },
  { name: 'sidecar', phase: 'Pending', ready: 0, reason: 'ImagePullBackOff' },
  { name: 'gone', phase: 'Failed', ready: 0 },
];

describeEachDialect('clusterSummary', (ctx) => {
  beforeAll(async () => {
    await migrateToLatest(ctx.db, ctx.kind);

    for (const [index, pod] of PODS.entries()) {
      await ctx.db
        .insertInto('facet_workloads')
        .values({
          observed_at: NOW,
          integration: 'core',
          namespace: 'default',
          name: pod.name,
          kind: 'Pod',
          node: 'ken',
          phase: pod.phase,
          reason: pod.reason ?? null,
          ready: pod.ready,
          restarts: index,
          images: 'nginx',
          owner_kind: null,
          owner_name: null,
          created_at: NOW,
          attrs: '{}',
        })
        .execute();
    }

    for (const [index, ready] of [1, 1, 0].entries()) {
      await ctx.db
        .insertInto('facet_nodes')
        .values({
          observed_at: NOW,
          integration: 'core',
          name: `node-${index}`,
          roles: '',
          ready,
          kubelet_version: 'v1.36.3',
          os_image: 'NixOS',
          architecture: 'amd64',
          capacity_cpu_milli: 12_000,
          capacity_memory_bytes: 24_000_000_000,
          capacity_pods: 110,
          allocatable_cpu_milli: 11_000,
          allocatable_memory_bytes: 23_000_000_000,
          allocatable_pods: 110,
          created_at: NOW,
          attrs: '{}',
        })
        .execute();
    }

    for (const [at, type] of [
      [NOW - 60_000, 'Warning'],
      [NOW - 120_000, 'Warning'],
      // Older than the window, and a normal event: neither is a complaint now.
      [NOW - WARNING_WINDOW_MS - 1000, 'Warning'],
      [NOW - 60_000, 'Normal'],
    ] as const) {
      await ctx.db
        .insertInto('facet_events')
        .values({
          at,
          integration: 'core',
          namespace: 'default',
          kind: 'Pod',
          name: 'web-1',
          reason: 'BackOff',
          message: 'restarting',
          type,
          count: 1,
          attrs: '{}',
        })
        .execute();
    }
  });

  it('counts pods by the phase they are in', async () => {
    const summary = await clusterSummary(ctx.db, NOW);

    expect(summary.pods.total).toBe(8);
    expect(summary.pods.running).toBe(3);
    expect(summary.pods.pending).toBe(3);
    expect(summary.pods.succeeded).toBe(1);
    expect(summary.pods.failed).toBe(1);
  });

  /** A phase of `Running` on a pod serving nothing is the state worth surfacing. */
  it('counts pods that are running without being ready', async () => {
    expect((await clusterSummary(ctx.db, NOW)).pods.degraded).toBe(1);
  });

  it('names why pods are not running, worst first', async () => {
    const { troubled } = (await clusterSummary(ctx.db, NOW)).pods;

    expect(troubled[0]).toEqual({ reason: 'CrashLoopBackOff', count: 2 });
    expect(troubled[1]).toEqual({ reason: 'ImagePullBackOff', count: 1 });
  });

  it('sums what the nodes declare they have', async () => {
    const summary = await clusterSummary(ctx.db, NOW);

    expect(summary.nodes).toEqual({ total: 3, ready: 2 });
    expect(summary.capacity.cpuMilli).toBe(36_000);
    expect(summary.capacity.memoryBytes).toBe(72_000_000_000);
    expect(summary.capacity.pods).toBe(330);
  });

  it('counts only the warnings inside the window', async () => {
    expect((await clusterSummary(ctx.db, NOW)).warnings).toBe(2);
  });

  it('stops counting a warning once it has aged out of the window', async () => {
    const later = await clusterSummary(ctx.db, NOW + 10 * WARNING_WINDOW_MS);

    expect(later.warnings).toBe(0);
    // The rest of the cluster is state, not history: it does not age.
    expect(later.pods.total).toBe(8);
  });
});
