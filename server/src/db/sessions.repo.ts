import { randomBytes } from 'node:crypto';
import type { Kysely } from 'kysely';
import type { Database } from './schema.js';

export interface Session {
  id: string;
  accountId: string;
  createdAt: number;
  expiresAt: number;
  lastSeenAt: number;
}

export class SessionsRepo {
  readonly #db: Kysely<Database>;

  constructor(db: Kysely<Database>) {
    this.#db = db;
  }

  async create(accountId: string, ttlMs: number, now: number): Promise<Session> {
    // 256 bits of entropy: the id is the credential inside the signed token,
    // so it must not be guessable even if the token format is known.
    const row = {
      id: randomBytes(32).toString('hex'),
      account_id: accountId,
      created_at: now,
      expires_at: now + ttlMs,
      last_seen_at: now,
    };

    await this.#db.insertInto('sessions').values(row).execute();
    return toSession(row);
  }

  async byId(id: string): Promise<Session | undefined> {
    const row = await this.#db
      .selectFrom('sessions')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();

    return row && toSession(row);
  }

  async touch(id: string, now: number): Promise<void> {
    await this.#db
      .updateTable('sessions')
      .set({ last_seen_at: now })
      .where('id', '=', id)
      .execute();
  }

  async delete(id: string): Promise<void> {
    await this.#db.deleteFrom('sessions').where('id', '=', id).execute();
  }

  /** Used when a password changes: every other session must stop working. */
  async deleteForAccount(accountId: string, except?: string): Promise<number> {
    let query = this.#db.deleteFrom('sessions').where('account_id', '=', accountId);
    if (except !== undefined) query = query.where('id', '!=', except);

    const result = await query.executeTakeFirst();
    return Number(result?.numDeletedRows ?? 0n);
  }

  async deleteExpired(now: number): Promise<number> {
    const result = await this.#db
      .deleteFrom('sessions')
      .where('expires_at', '<=', now)
      .executeTakeFirst();

    return Number(result?.numDeletedRows ?? 0n);
  }
}

interface SessionRow {
  id: string;
  account_id: string;
  created_at: number;
  expires_at: number;
  last_seen_at: number;
}

function toSession(row: SessionRow): Session {
  return {
    id: row.id,
    accountId: row.account_id,
    createdAt: Number(row.created_at),
    expiresAt: Number(row.expires_at),
    lastSeenAt: Number(row.last_seen_at),
  };
}
