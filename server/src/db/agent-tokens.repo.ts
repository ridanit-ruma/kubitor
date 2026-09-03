import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Kysely } from 'kysely';
import type { Database } from './schema.js';

export interface AgentToken {
  node: string;
  createdAt: number;
  lastSeenAt: number | null;
}

/**
 * Tokens are stored hashed.
 *
 * A leaked database should not hand an attacker the ability to write telemetry
 * for every node, and the plaintext is only ever shown once at issue time.
 */
function hash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export class AgentTokensRepo {
  readonly #db: Kysely<Database>;

  constructor(db: Kysely<Database>) {
    this.#db = db;
  }

  async issue(node: string, now: number): Promise<string> {
    const token = randomBytes(32).toString('base64url');

    await this.#db
      .insertInto('agent_tokens')
      .values({ node, token_hash: hash(token), created_at: now, last_seen_at: null })
      .onConflict((oc) =>
        oc.column('node').doUpdateSet({ token_hash: hash(token), created_at: now }),
      )
      .execute();

    return token;
  }

  /**
   * The node a token belongs to, or null.
   *
   * The comparison is over the whole candidate set with `timingSafeEqual`, so a
   * caller cannot learn which node a partially-correct token belongs to from how
   * long the answer took.
   */
  async nodeFor(token: string): Promise<string | null> {
    const candidate = Buffer.from(hash(token), 'hex');
    const rows = await this.#db.selectFrom('agent_tokens').selectAll().execute();

    let match: string | null = null;
    for (const row of rows) {
      const stored = Buffer.from(row.token_hash, 'hex');
      if (stored.length === candidate.length && timingSafeEqual(stored, candidate)) {
        match = row.node;
      }
    }
    return match;
  }

  async touch(node: string, now: number): Promise<void> {
    await this.#db
      .updateTable('agent_tokens')
      .set({ last_seen_at: now })
      .where('node', '=', node)
      .execute();
  }

  async list(): Promise<AgentToken[]> {
    const rows = await this.#db
      .selectFrom('agent_tokens')
      .selectAll()
      .orderBy('node', 'asc')
      .execute();

    return rows.map((row) => ({
      node: row.node,
      createdAt: Number(row.created_at),
      lastSeenAt: row.last_seen_at === null ? null : Number(row.last_seen_at),
    }));
  }

  async revoke(node: string): Promise<void> {
    await this.#db.deleteFrom('agent_tokens').where('node', '=', node).execute();
  }
}
