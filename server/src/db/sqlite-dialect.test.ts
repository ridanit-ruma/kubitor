import { DatabaseSync } from 'node:sqlite';
import { type Generated, Kysely, sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NodeSqliteDialect } from './sqlite-dialect.js';

interface TestDatabase {
  // `id` is AUTOINCREMENT, so Kysely must treat it as optional on insert.
  widget: { id: Generated<number>; name: string; active: number; payload: string };
}

let db: Kysely<TestDatabase>;

beforeEach(async () => {
  db = new Kysely<TestDatabase>({
    dialect: new NodeSqliteDialect({ database: new DatabaseSync(':memory:') }),
  });
  await sql`CREATE TABLE widget (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    active INTEGER NOT NULL,
    payload TEXT NOT NULL
  )`.execute(db);
});

afterEach(async () => {
  await db.destroy();
});

describe('NodeSqliteDialect', () => {
  it('reports affected rows for statements that return none', async () => {
    const result = await db
      .insertInto('widget')
      .values({ name: 'a', active: 1, payload: '{}' })
      .executeTakeFirstOrThrow();

    expect(result.numInsertedOrUpdatedRows).toBe(1n);
    expect(result.insertId).toBe(1n);
  });

  it('returns rows for select', async () => {
    await db.insertInto('widget').values({ name: 'a', active: 1, payload: '{}' }).execute();
    const rows = await db.selectFrom('widget').selectAll().execute();

    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe('a');
  });

  it('returns rows for insert ... returning', async () => {
    const row = await db
      .insertInto('widget')
      .values({ name: 'b', active: 0, payload: '{}' })
      .returning('id')
      .executeTakeFirstOrThrow();

    expect(row.id).toBe(1);
  });

  it('coerces booleans, which node:sqlite refuses to bind', async () => {
    await db
      .insertInto('widget')
      .values({ name: 'c', active: true as unknown as number, payload: '{}' })
      .execute();

    const row = await db.selectFrom('widget').select('active').executeTakeFirstOrThrow();
    expect(row.active).toBe(1);
  });

  it('rolls a transaction back', async () => {
    await expect(
      db.transaction().execute(async (trx) => {
        await trx.insertInto('widget').values({ name: 'd', active: 1, payload: '{}' }).execute();
        throw new Error('deliberate');
      }),
    ).rejects.toThrow('deliberate');

    const rows = await db.selectFrom('widget').selectAll().execute();
    expect(rows).toHaveLength(0);
  });

  it('commits a transaction', async () => {
    await db.transaction().execute(async (trx) => {
      await trx.insertInto('widget').values({ name: 'e', active: 1, payload: '{}' }).execute();
    });

    const rows = await db.selectFrom('widget').selectAll().execute();
    expect(rows).toHaveLength(1);
  });

  it('serializes overlapping transactions instead of interleaving them', async () => {
    const insert = (name: string) =>
      db.transaction().execute(async (trx) => {
        await trx.insertInto('widget').values({ name, active: 1, payload: '{}' }).execute();
      });

    await Promise.all([insert('f'), insert('g'), insert('h')]);

    const rows = await db.selectFrom('widget').selectAll().execute();
    expect(rows).toHaveLength(3);
  });
});
