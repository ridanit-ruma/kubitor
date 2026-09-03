import type { DegradedReason, IntegrationOverride, IntegrationState } from '@kubitor/shared';
import type { Kysely } from 'kysely';
import type { DialectSql } from './dialect.js';
import type { Database } from './schema.js';

export interface StoredIntegrationState {
  id: string;
  state: IntegrationState;
  version: string | null;
  evidence: string;
  unknownReason: 'rbac' | 'error' | null;
  override: IntegrationOverride;
  degraded: DegradedReason[];
  checkedAt: number;
}

export class IntegrationStateRepo {
  readonly #db: Kysely<Database>;
  readonly #sql: DialectSql;

  constructor(db: Kysely<Database>, dialect: DialectSql) {
    this.#db = db;
    this.#sql = dialect;
  }

  async list(): Promise<StoredIntegrationState[]> {
    const rows = await this.#db.selectFrom('integration_state').selectAll().execute();
    return rows.map((row) => this.#toState(row));
  }

  async byId(id: string): Promise<StoredIntegrationState | undefined> {
    const row = await this.#db
      .selectFrom('integration_state')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();

    return row && this.#toState(row);
  }

  /** Writes the probe result while preserving whatever override the user set. */
  async recordDetection(state: Omit<StoredIntegrationState, 'override'>): Promise<void> {
    const values = {
      id: state.id,
      state: state.state,
      version: state.version,
      evidence: state.evidence,
      unknown_reason: state.unknownReason,
      degraded: this.#sql.encodeJson(state.degraded),
      checked_at: state.checkedAt,
    };

    await this.#db
      .insertInto('integration_state')
      .values({ ...values, override: 'auto' })
      .onConflict((oc) => oc.column('id').doUpdateSet(values))
      .execute();
  }

  async setOverride(id: string, override: IntegrationOverride): Promise<void> {
    await this.#db
      .updateTable('integration_state')
      .set({ override })
      .where('id', '=', id)
      .execute();
  }

  #toState(row: Database['integration_state']): StoredIntegrationState {
    return {
      id: row.id,
      state: row.state as IntegrationState,
      version: row.version,
      evidence: row.evidence,
      unknownReason: row.unknown_reason as 'rbac' | 'error' | null,
      override: row.override as IntegrationOverride,
      degraded: this.#sql.decodeJson<DegradedReason[]>(row.degraded),
      checkedAt: Number(row.checked_at),
    };
  }
}
