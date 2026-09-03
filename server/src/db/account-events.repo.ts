import type { Kysely } from 'kysely';
import type { DialectSql } from './dialect.js';
import type { AccountAction, Database } from './schema.js';

export interface AccountEvent {
  at: number;
  actorId: string | null;
  action: AccountAction;
  /** Username the action was taken against. */
  subject: string;
  detail: Record<string, unknown>;
}

export class AccountEventsRepo {
  readonly #db: Kysely<Database>;
  readonly #sql: DialectSql;

  constructor(db: Kysely<Database>, dialect: DialectSql) {
    this.#db = db;
    this.#sql = dialect;
  }

  async record(event: AccountEvent): Promise<void> {
    await this.#db
      .insertInto('account_events')
      .values({
        at: event.at,
        actor_id: event.actorId,
        action: event.action,
        subject: event.subject,
        detail: this.#sql.encodeJson(event.detail),
      })
      .execute();
  }

  async list(limit: number): Promise<AccountEvent[]> {
    const rows = await this.#db
      .selectFrom('account_events')
      .selectAll()
      .orderBy('at', 'desc')
      .limit(limit)
      .execute();

    return rows.map((row) => ({
      at: Number(row.at),
      actorId: row.actor_id,
      action: row.action as AccountAction,
      subject: row.subject,
      detail: this.#sql.decodeJson<Record<string, unknown>>(row.detail),
    }));
  }
}
