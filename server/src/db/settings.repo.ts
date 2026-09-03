import type { Kysely } from 'kysely';
import { decodeJson } from './dialect.js';
import type { Database } from './schema.js';

/** Key/value configuration, stored as JSON documents. */
export class SettingsRepo {
  readonly #db: Kysely<Database>;

  constructor(db: Kysely<Database>) {
    this.#db = db;
  }

  async get<T>(key: string): Promise<T | undefined> {
    const row = await this.#db
      .selectFrom('settings')
      .select('value')
      .where('key', '=', key)
      .executeTakeFirst();

    return row === undefined ? undefined : decodeJson<T>(row.value);
  }

  async set<T>(key: string, value: T, now: number): Promise<void> {
    const encoded = JSON.stringify(value);

    await this.#db
      .insertInto('settings')
      .values({ key, value: encoded, updated_at: now })
      .onConflict((oc) => oc.column('key').doUpdateSet({ value: encoded, updated_at: now }))
      .execute();
  }

  async all(): Promise<Record<string, unknown>> {
    const rows = await this.#db.selectFrom('settings').select(['key', 'value']).execute();

    const result: Record<string, unknown> = {};
    for (const row of rows) {
      result[row.key] = decodeJson(row.value);
    }
    return result;
  }
}
