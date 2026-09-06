import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDb } from '../db/connect.js';
import { migrateToLatest } from '../db/migrate.js';
import { snapshot } from './snapshot.js';

let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(process.cwd(), '.tmptest', 'snapshot-'));
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

async function seeded() {
  const db = createDb({ kind: 'sqlite', sqlitePath: join(directory, 'source.db') });
  await migrateToLatest(db, 'sqlite');

  await db
    .insertInto('agent_tokens')
    .values(
      Array.from({ length: 50 }, (_, index) => ({
        node: `host-${index}`,
        token_hash: `hash-${index}`,
        created_at: 1_756_800_000_000 + index,
        last_seen_at: null,
      })),
    )
    .execute();

  return db;
}

describe('snapshot', () => {
  /**
   * The whole reason this function exists. In WAL mode the `.db` file is not
   * the database — committed transactions live in `-wal` until a checkpoint —
   * so copying the file of a database that is being written to produces
   * something that opens and is missing rows. `VACUUM INTO` is a read
   * transaction, so what it writes is a whole database.
   */
  it('copies a database that is open and being written to', async () => {
    const db = await seeded();
    const destination = join(directory, 'copy.db');

    // A write in flight while the snapshot is taken.
    const writing = db
      .insertInto('agent_tokens')
      .values({
        node: 'during',
        token_hash: 'h',
        created_at: 1,
        last_seen_at: null,
      })
      .execute();

    const result = await snapshot(db, destination);
    await writing;

    const copy = createDb({ kind: 'sqlite', sqlitePath: destination });
    const rows = await copy.selectFrom('agent_tokens').selectAll().execute();

    expect(rows.length).toBeGreaterThanOrEqual(50);
    expect(result.path).toBe(destination);
    expect(result.bytes).toBe(statSync(destination).size);
    await copy.destroy();
    await db.destroy();
  });

  it('reports the size, because the caller has to decide whether it fits', async () => {
    const db = await seeded();
    const result = await snapshot(db, join(directory, 'copy.db'));

    expect(result.bytes).toBeGreaterThan(0);
    await db.destroy();
  });

  /** `VACUUM INTO` refuses to overwrite, so a retry has to start clean. */
  it('replaces a file left behind by an earlier attempt', async () => {
    const db = await seeded();
    const destination = join(directory, 'copy.db');

    await snapshot(db, destination);
    await expect(snapshot(db, destination)).resolves.toMatchObject({ path: destination });

    await db.destroy();
  });

  it('reports a destination it cannot write rather than pretending', async () => {
    const db = await seeded();

    await expect(snapshot(db, join(directory, 'nope', 'copy.db'))).rejects.toThrow();
    await db.destroy();
  });
});
