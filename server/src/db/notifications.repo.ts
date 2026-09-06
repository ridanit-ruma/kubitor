import type { Kysely, Selectable } from 'kysely';
import type { Database } from './schema.js';

export interface QueuedNotification {
  /** Monotonic, and therefore the order these must be delivered in. */
  seq: number;
  alertId: string;
  channel: string;
  kind: 'fired' | 'resolved';
  createdAt: number;
  attempts: number;
  nextAttemptAt: number;
  finishedAt: number | null;
  delivered: boolean;
  error: string | null;
}

export class NotificationsRepo {
  readonly #db: Kysely<Database>;

  constructor(db: Kysely<Database>) {
    this.#db = db;
  }

  async enqueue(entry: {
    alertId: string;
    channel: string;
    kind: 'fired' | 'resolved';
    at: number;
  }): Promise<void> {
    await this.#db
      .insertInto('notifications')
      .values({
        alert_id: entry.alertId,
        channel: entry.channel,
        kind: entry.kind,
        created_at: entry.at,
        attempts: 0,
        next_attempt_at: entry.at,
        finished_at: null,
        delivered: 0,
        error: null,
      })
      .execute();
  }

  /**
   * What is due to be sent now.
   *
   * Ordered oldest first so a channel that comes back after an outage delivers
   * what happened in the order it happened — a recovery arriving before the
   * failure it recovered from is worse than either arriving late.
   */
  async due(now: number, limit = 20): Promise<QueuedNotification[]> {
    const rows = await this.#db
      .selectFrom('notifications')
      .selectAll()
      .where('finished_at', 'is', null)
      .where('next_attempt_at', '<=', now)
      // The sequence, not the clock: a batch of transitions is queued inside
      // one millisecond, and `created_at` cannot order what it cannot separate.
      .orderBy('seq', 'asc')
      .limit(limit)
      .execute();

    return rows.map(toQueued);
  }

  async delivered(seq: number, at: number): Promise<void> {
    await this.#db
      .updateTable('notifications')
      .set({ finished_at: at, delivered: 1, error: null })
      .where('seq', '=', seq)
      .execute();
  }

  /** Records a failed attempt and when the next one is due. */
  async retryAfter(
    seq: number,
    attempts: number,
    nextAttemptAt: number,
    error: string,
  ): Promise<void> {
    await this.#db
      .updateTable('notifications')
      .set({ attempts, next_attempt_at: nextAttemptAt, error: error.slice(0, 1024) })
      .where('seq', '=', seq)
      .execute();
  }

  /** Stops trying, and says so on the screen rather than in silence. */
  async giveUp(seq: number, attempts: number, at: number, error: string): Promise<void> {
    await this.#db
      .updateTable('notifications')
      .set({ attempts, finished_at: at, delivered: 0, error: error.slice(0, 1024) })
      .where('seq', '=', seq)
      .execute();
  }

  async recent(limit = 50): Promise<QueuedNotification[]> {
    const rows = await this.#db
      .selectFrom('notifications')
      .selectAll()
      .orderBy('seq', 'desc')
      .limit(limit)
      .execute();

    return rows.map(toQueued);
  }

  /** How many are waiting, which is the number that says a channel is broken. */
  async pendingCount(): Promise<number> {
    const row = await this.#db
      .selectFrom('notifications')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('finished_at', 'is', null)
      .executeTakeFirst();

    return Number(row?.n ?? 0);
  }
}

function toQueued(row: Selectable<Database['notifications']>): QueuedNotification {
  return {
    seq: Number(row.seq),
    alertId: row.alert_id,
    channel: row.channel,
    kind: row.kind === 'resolved' ? 'resolved' : 'fired',
    createdAt: Number(row.created_at),
    attempts: row.attempts,
    nextAttemptAt: Number(row.next_attempt_at),
    finishedAt: row.finished_at === null ? null : Number(row.finished_at),
    delivered: row.delivered === 1,
    error: row.error,
  };
}
