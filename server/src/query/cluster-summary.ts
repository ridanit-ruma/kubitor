import type { Kysely } from 'kysely';
import type { Database } from '../db/schema.js';

/**
 * What a cluster is doing, in the few numbers an overview screen exists for.
 *
 * Counted in the database rather than by fetching rows and tallying them in the
 * browser: a page of a hundred workloads would have made "how many pods are
 * running" a question about the first page.
 */
export interface ClusterSummary {
  nodes: { total: number; ready: number };
  pods: {
    total: number;
    running: number;
    pending: number;
    succeeded: number;
    failed: number;
    /**
     * Running, but not every container in them is.
     *
     * The state that hides: the phase says `Running` and the workload is not
     * serving. It is the reason `ready` is stored beside `phase`.
     */
    degraded: number;
    /** Why pods are not running, worst first. `CrashLoopBackOff` and its kin. */
    troubled: { reason: string; count: number }[];
  };
  /** What the nodes declare they have, summed. */
  capacity: { cpuMilli: number; memoryBytes: number; pods: number };
  /** Warning events in the last hour — the cluster's own complaints. */
  warnings: number;
}

/** How far back "recent" reaches for the warning count. */
export const WARNING_WINDOW_MS = 3_600_000;

/** How many distinct failure reasons are worth naming before "and others". */
const MAX_REASONS = 4;

export async function clusterSummary(db: Kysely<Database>, now: number): Promise<ClusterSummary> {
  const [nodes, phases, degraded, reasons, warnings] = await Promise.all([
    db
      .selectFrom('facet_nodes')
      .select((eb) => [
        eb.fn.countAll<number>().as('total'),
        eb.fn.sum<number>('ready').as('ready'),
        eb.fn.sum<number>('capacity_cpu_milli').as('cpu_milli'),
        eb.fn.sum<number>('capacity_memory_bytes').as('memory_bytes'),
        eb.fn.sum<number>('capacity_pods').as('pods'),
      ])
      .executeTakeFirst(),

    db
      .selectFrom('facet_workloads')
      .select((eb) => ['phase', eb.fn.countAll<number>().as('count')])
      .groupBy('phase')
      .execute(),

    db
      .selectFrom('facet_workloads')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where('phase', '=', 'Running')
      .where('ready', '=', 0)
      .executeTakeFirst(),

    db
      .selectFrom('facet_workloads')
      .select((eb) => ['reason', eb.fn.countAll<number>().as('count')])
      .where('reason', 'is not', null)
      .where('reason', '!=', '')
      .groupBy('reason')
      .orderBy('count', 'desc')
      .limit(MAX_REASONS)
      .execute(),

    db
      .selectFrom('facet_events')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where('type', '=', 'Warning')
      .where('at', '>=', now - WARNING_WINDOW_MS)
      .executeTakeFirst(),
  ]);

  const byPhase = (phase: string): number =>
    Number(phases.find((row) => row.phase === phase)?.count ?? 0);

  return {
    nodes: {
      total: Number(nodes?.total ?? 0),
      ready: Number(nodes?.ready ?? 0),
    },
    pods: {
      total: phases.reduce((sum, row) => sum + Number(row.count), 0),
      running: byPhase('Running'),
      pending: byPhase('Pending'),
      succeeded: byPhase('Succeeded'),
      failed: byPhase('Failed'),
      degraded: Number(degraded?.count ?? 0),
      troubled: reasons
        .filter((row): row is { reason: string; count: number } => row.reason !== null)
        .map((row) => ({ reason: row.reason, count: Number(row.count) })),
    },
    capacity: {
      cpuMilli: Number(nodes?.cpu_milli ?? 0),
      memoryBytes: Number(nodes?.memory_bytes ?? 0),
      pods: Number(nodes?.pods ?? 0),
    },
    warnings: Number(warnings?.count ?? 0),
  };
}
