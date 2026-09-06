import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import type { Database } from './schema.js';

/** One attempt, as the screen reads it. */
export interface BackupRecord {
  id: string;
  startedAt: number;
  finishedAt: number | null;
  key: string | null;
  bytes: number | null;
  encrypted: boolean;
  verified: boolean;
  ok: boolean;
  error: string | null;
}

export class BackupsRepo {
  readonly #db: Kysely<Database>;

  constructor(db: Kysely<Database>) {
    this.#db = db;
  }

  /** Records the attempt before it starts, so a crash mid-backup leaves a trace. */
  async start(now: number): Promise<string> {
    const id = randomUUID();

    await this.#db
      .insertInto('backups')
      .values({
        id,
        started_at: now,
        finished_at: null,
        key: null,
        bytes: null,
        encrypted: 0,
        verified: 0,
        ok: 0,
        error: null,
      })
      .execute();

    return id;
  }

  async finish(
    id: string,
    now: number,
    outcome: {
      key?: string;
      bytes?: number;
      encrypted?: boolean;
      verified?: boolean;
      ok: boolean;
      error?: string;
    },
  ): Promise<void> {
    await this.#db
      .updateTable('backups')
      .set({
        finished_at: now,
        ...(outcome.key === undefined ? {} : { key: outcome.key }),
        ...(outcome.bytes === undefined ? {} : { bytes: outcome.bytes }),
        encrypted: outcome.encrypted ? 1 : 0,
        verified: outcome.verified ? 1 : 0,
        ok: outcome.ok ? 1 : 0,
        ...(outcome.error === undefined ? {} : { error: outcome.error.slice(0, 1024) }),
      })
      .where('id', '=', id)
      .execute();
  }

  async recent(limit = 20): Promise<BackupRecord[]> {
    const rows = await this.#db
      .selectFrom('backups')
      .selectAll()
      .orderBy('started_at', 'desc')
      .orderBy('id', 'asc')
      .limit(limit)
      .execute();

    return rows.map(toRecord);
  }

  /**
   * The newest attempt that was read back and opened.
   *
   * "Newest backup" on its own would count one that uploaded and could not be
   * re-read, which is the case this whole feature exists to notice.
   */
  async newestVerified(): Promise<BackupRecord | null> {
    const row = await this.#db
      .selectFrom('backups')
      .selectAll()
      .where('ok', '=', 1)
      .where('verified', '=', 1)
      .orderBy('started_at', 'desc')
      .executeTakeFirst();

    return row ? toRecord(row) : null;
  }
}

function toRecord(row: Database['backups']): BackupRecord {
  return {
    id: row.id,
    startedAt: Number(row.started_at),
    finishedAt: row.finished_at === null ? null : Number(row.finished_at),
    key: row.key,
    bytes: row.bytes === null ? null : Number(row.bytes),
    encrypted: row.encrypted === 1,
    verified: row.verified === 1,
    ok: row.ok === 1,
    error: row.error,
  };
}
