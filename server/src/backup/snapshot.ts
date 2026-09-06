import { statSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { type Kysely, sql } from 'kysely';
import type { Database } from '../db/schema.js';

export interface Snapshot {
  path: string;
  bytes: number;
}

/** How many times a busy database is worth waiting for. */
const ATTEMPTS = 5;
const BACKOFF_MS = 250;

/**
 * A whole, consistent copy of a database that is still being written to.
 *
 * Not `cp`. kubitor runs SQLite in WAL mode, where the `.db` file is not the
 * database: committed transactions live in `-wal` until a checkpoint, so a
 * copy of the file alone opens fine and is missing whatever had not been
 * checkpointed. That is discovered at restore time, which is the worst moment
 * available.
 *
 * `VACUUM INTO` runs inside a read transaction, so what lands is a whole
 * database as of one instant, compacted on the way. `node:sqlite` offers no
 * backup API, and this needs none — it is plain SQL that every SQLite has.
 */
export async function snapshot(
  db: Kysely<Database>,
  destination: string,
  attempts = ATTEMPTS,
): Promise<Snapshot> {
  for (let attempt = 1; ; attempt += 1) {
    // `VACUUM INTO` refuses a destination that exists, so an abandoned attempt
    // would otherwise make every later one fail.
    await rm(destination, { force: true });

    try {
      await sql`VACUUM INTO ${sql.lit(destination)}`.execute(db);
      return { path: destination, bytes: statSync(destination).size };
    } catch (error) {
      // A concurrent write is a wait, not a failure; anything else is real.
      if (attempt >= attempts || !isBusy(error)) throw error;
      await delay(BACKOFF_MS * attempt);
    }
  }
}

function isBusy(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /busy|locked/i.test(message);
}
