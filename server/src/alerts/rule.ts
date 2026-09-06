export type Severity = 'critical' | 'warning';

/**
 * One thing that is wrong right now.
 *
 * `subject` is what it is wrong *about* — a node name, a namespaced pod — and
 * it is half of an alert's identity. Two observations with the same rule and
 * subject on successive evaluations are the same alert continuing, not two
 * alerts; that distinction is the whole reason this type exists rather than
 * rules emitting messages.
 */
export interface Observation {
  subject: string;
  summary: string;
  detail?: string;
  attrs?: Record<string, unknown>;
}

/**
 * What a rule can look at.
 *
 * Deliberately small and injected: a rule is then a pure function of a snapshot,
 * and testing one needs no database, no cluster and no clock.
 */
export interface World {
  nodes: readonly { name: string; ready: number }[];
  pods: readonly {
    namespace: string;
    name: string;
    phase: string;
    reason: string | null;
    ready: number;
    restarts: number;
  }[];
  /** Machines with a credential that have stopped reporting. */
  staleAgents: readonly string[];
  /** The most recent finished backup, if backups are configured at all. */
  lastBackup: { ok: boolean; error: string | null; startedAt: number } | null;
  now: number;
}

export interface AlertRule {
  id: string;
  title: string;
  severity: Severity;
  /**
   * How many consecutive evaluations the condition must hold before it fires,
   * and how many it must be absent before it resolves.
   *
   * A pod restarting once is not an incident and a flapping node must not
   * produce forty messages. Damping is what makes the difference between a
   * channel people read and one they mute.
   */
  fireAfter: number;
  resolveAfter: number;
  observe(world: World): Observation[];
}
