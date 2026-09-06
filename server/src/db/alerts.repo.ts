import type { Kysely } from 'kysely';
import type { DialectSql } from './dialect.js';
import type { Database } from './schema.js';

export interface AlertRecord {
  id: string;
  rule: string;
  subject: string;
  severity: string;
  summary: string;
  detail: string | null;
  state: 'pending' | 'firing';
  seenCount: number;
  missingCount: number;
  firstSeenAt: number;
  lastSeenAt: number;
  firedAt: number | null;
  resolvedAt: number | null;
  attrs: Record<string, unknown>;
}

export interface NewAlert {
  id: string;
  rule: string;
  subject: string;
  severity: string;
  summary: string;
  detail: string | null;
  state: 'pending' | 'firing';
  seenCount: number;
  missingCount: number;
  firstSeenAt: number;
  lastSeenAt: number;
  firedAt: number | null;
  attrs: Record<string, unknown>;
}

export interface AlertPatch {
  state?: 'pending' | 'firing';
  seenCount?: number;
  missingCount?: number;
  lastSeenAt?: number;
  firedAt?: number;
  resolvedAt?: number;
  summary?: string;
  detail?: string | null;
  attrs?: Record<string, unknown>;
}

export class AlertsRepo {
  readonly #db: Kysely<Database>;
  readonly #sql: DialectSql;

  constructor(db: Kysely<Database>, dialect: DialectSql) {
    this.#db = db;
    this.#sql = dialect;
  }

  async create(alert: NewAlert): Promise<AlertRecord> {
    await this.#db
      .insertInto('alerts')
      .values({
        id: alert.id,
        rule: alert.rule,
        subject: alert.subject,
        severity: alert.severity,
        summary: alert.summary,
        detail: alert.detail,
        state: alert.state,
        seen_count: alert.seenCount,
        missing_count: alert.missingCount,
        first_seen_at: alert.firstSeenAt,
        last_seen_at: alert.lastSeenAt,
        fired_at: alert.firedAt,
        resolved_at: null,
        attrs: this.#sql.encodeJson(alert.attrs),
      })
      .execute();

    return { ...alert, resolvedAt: null };
  }

  /**
   * The alerts this rule still has open.
   *
   * "Open" is `resolved_at IS NULL`, not a state: a resolved alert keeps its
   * row so the history is a history, and a later recurrence is a new alert
   * rather than a resurrected one.
   */
  async openFor(rule: string): Promise<AlertRecord[]> {
    const rows = await this.#db
      .selectFrom('alerts')
      .selectAll()
      .where('rule', '=', rule)
      .where('resolved_at', 'is', null)
      .orderBy('first_seen_at', 'asc')
      .orderBy('subject', 'asc')
      .execute();

    return rows.map((row) => this.#toRecord(row));
  }

  async update(id: string, patch: AlertPatch): Promise<AlertRecord> {
    await this.#db
      .updateTable('alerts')
      .set({
        ...(patch.state === undefined ? {} : { state: patch.state }),
        ...(patch.seenCount === undefined ? {} : { seen_count: patch.seenCount }),
        ...(patch.missingCount === undefined ? {} : { missing_count: patch.missingCount }),
        ...(patch.lastSeenAt === undefined ? {} : { last_seen_at: patch.lastSeenAt }),
        ...(patch.firedAt === undefined ? {} : { fired_at: patch.firedAt }),
        ...(patch.resolvedAt === undefined ? {} : { resolved_at: patch.resolvedAt }),
        ...(patch.summary === undefined ? {} : { summary: patch.summary }),
        ...(patch.detail === undefined ? {} : { detail: patch.detail }),
        ...(patch.attrs === undefined ? {} : { attrs: this.#sql.encodeJson(patch.attrs) }),
      })
      .where('id', '=', id)
      .execute();

    const row = await this.#db
      .selectFrom('alerts')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow();

    return this.#toRecord(row);
  }

  async byId(id: string): Promise<AlertRecord | null> {
    const row = await this.#db
      .selectFrom('alerts')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();

    return row ? this.#toRecord(row) : null;
  }

  /** Everything currently firing, worst first. What a screen leads with. */
  async firing(): Promise<AlertRecord[]> {
    const rows = await this.#db
      .selectFrom('alerts')
      .selectAll()
      .where('resolved_at', 'is', null)
      .where('state', '=', 'firing')
      .orderBy('severity', 'asc')
      .orderBy('first_seen_at', 'asc')
      .orderBy('id', 'asc')
      .execute();

    return rows.map((row) => this.#toRecord(row));
  }

  /** What has happened lately, resolved included. */
  async recent(limit = 100): Promise<AlertRecord[]> {
    const rows = await this.#db
      .selectFrom('alerts')
      .selectAll()
      .orderBy('first_seen_at', 'desc')
      .orderBy('id', 'asc')
      .limit(limit)
      .execute();

    return rows.map((row) => this.#toRecord(row));
  }

  #toRecord(row: Database['alerts']): AlertRecord {
    return {
      id: row.id,
      rule: row.rule,
      subject: row.subject,
      severity: row.severity,
      summary: row.summary,
      detail: row.detail,
      state: row.state === 'firing' ? 'firing' : 'pending',
      seenCount: row.seen_count,
      missingCount: row.missing_count,
      firstSeenAt: Number(row.first_seen_at),
      lastSeenAt: Number(row.last_seen_at),
      firedAt: row.fired_at === null ? null : Number(row.fired_at),
      resolvedAt: row.resolved_at === null ? null : Number(row.resolved_at),
      attrs: this.#sql.decodeJson(row.attrs),
    };
  }
}
