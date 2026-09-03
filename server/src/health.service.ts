import { type Kysely, sql } from 'kysely';
import type { Database } from './db/schema.js';

/** Plain class: constructed by the composition root, not by the container. */
export class HealthService {
  readonly #db: Kysely<Database>;

  constructor(db: Kysely<Database>) {
    this.#db = db;
  }

  async databaseReachable(): Promise<boolean> {
    try {
      await sql`SELECT 1`.execute(this.#db);
      return true;
    } catch {
      return false;
    }
  }
}
