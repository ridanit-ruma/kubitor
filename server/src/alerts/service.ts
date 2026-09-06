import type { Kysely } from 'kysely';
import type { AlertRecord, AlertsRepo } from '../db/alerts.repo.js';
import type { BackupsRepo } from '../db/backups.repo.js';
import type { Database } from '../db/schema.js';
import { evaluate, type Transition } from './evaluator.js';
import type { AlertRule, World } from './rule.js';
import { CORE_RULES } from './rules.js';

/**
 * How often the rules are evaluated.
 *
 * Not the push cadence and not the storage cadence. A minute is fast enough
 * that nobody learns about an outage from somewhere else first, and slow enough
 * that damping counted in evaluations means something in wall-clock time: two
 * evaluations is two minutes, which is about how long a kubelet restart takes.
 */
export const EVALUATION_INTERVAL_MS = 60_000;

export interface AlertsDeps {
  db: Kysely<Database>;
  alerts: AlertsRepo;
  backups: BackupsRepo | null;
  /** Machines with a credential that have stopped reporting. */
  staleAgents(): Promise<readonly string[]>;
  now(): number;
  rules?: readonly AlertRule[];
  onTransitions?(transitions: readonly Transition[]): void;
  log?(message: string): void;
}

/**
 * Evaluates the rules on a timer and keeps the alert table true.
 *
 * The transitions it produces are what a notifier will consume; nothing sends
 * anything yet, and that is the right order — a delivery channel built before
 * this existed would have had nothing to send but a firehose of duplicates.
 */
export class AlertsService {
  readonly #deps: AlertsDeps;
  readonly #rules: readonly AlertRule[];
  #timer: ReturnType<typeof setInterval> | null = null;
  #running = false;

  constructor(deps: AlertsDeps) {
    this.#deps = deps;
    this.#rules = deps.rules ?? CORE_RULES;
  }

  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => void this.evaluateOnce(), EVALUATION_INTERVAL_MS);
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  async firing(): Promise<AlertRecord[]> {
    return this.#deps.alerts.firing();
  }

  async recent(limit?: number): Promise<AlertRecord[]> {
    return this.#deps.alerts.recent(limit);
  }

  /**
   * One pass. Never throws: a rule that cannot read the database must not stop
   * the timer, because losing the timer ends every future evaluation silently.
   */
  async evaluateOnce(): Promise<Transition[]> {
    if (this.#running) return [];
    this.#running = true;

    try {
      const world = await this.#world();
      const transitions = await evaluate({ rules: this.#rules, world, repo: this.#deps.alerts });

      for (const transition of transitions) {
        this.#deps.log?.(
          `alert ${transition.kind}: [${transition.alert.severity}] ${transition.alert.summary}`,
        );
      }
      if (transitions.length > 0) this.#deps.onTransitions?.(transitions);

      return transitions;
    } catch (error) {
      this.#deps.log?.(`alert evaluation failed: ${String(error)}`);
      return [];
    } finally {
      this.#running = false;
    }
  }

  async #world(): Promise<World> {
    const [nodes, pods, staleAgents, backups] = await Promise.all([
      this.#deps.db.selectFrom('facet_nodes').select(['name', 'ready']).execute(),
      this.#deps.db
        .selectFrom('facet_workloads')
        .select(['namespace', 'name', 'phase', 'reason', 'ready', 'restarts'])
        // Only pods that are not simply running: the rules all key off a
        // reason, and reading every row of a large cluster to discard most of
        // them is work done once a minute for nothing.
        .where((eb) => eb.or([eb('reason', 'is not', null), eb('ready', '=', 0)]))
        .execute(),
      this.#deps.staleAgents(),
      this.#deps.backups?.recent(1) ?? Promise.resolve([]),
    ]);

    const last = backups.find((backup) => backup.finishedAt !== null);

    return {
      nodes,
      pods,
      staleAgents,
      lastBackup: last ? { ok: last.ok, error: last.error, startedAt: last.startedAt } : null,
      now: this.#deps.now(),
    };
  }
}
