import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';
import { describeEachDialect } from '../test/db-harness.js';
import { POSTGRES_SQL, SQLITE_SQL } from './dialect.js';

describe('dialect column types', () => {
  it('stores epoch milliseconds as an integer type on both dialects', () => {
    expect(SQLITE_SQL.timestampMs()).toBe('integer');
    expect(POSTGRES_SQL.timestampMs()).toBe('bigint');
  });

  it('uses the dialect-native JSON type', () => {
    expect(SQLITE_SQL.json()).toBe('text');
    expect(POSTGRES_SQL.json()).toBe('jsonb');
  });
});

describe('JSON codec', () => {
  it('parses the text sqlite hands back', () => {
    expect(SQLITE_SQL.decodeJson<{ a: number }>('{"a":1}')).toEqual({ a: 1 });
  });

  it('passes through what the postgres driver already parsed', () => {
    expect(POSTGRES_SQL.decodeJson<{ a: number }>({ a: 1 })).toEqual({ a: 1 });
  });

  /**
   * Regression: decoding used to branch on `typeof value === 'string'`, which
   * breaks for a JSON string scalar. node-postgres parses jsonb `"manual"` into
   * the JS string `manual`, and parsing that again throws.
   */
  it('does not re-parse a json string scalar returned by postgres', () => {
    expect(POSTGRES_SQL.decodeJson<string>('manual')).toBe('manual');
  });

  it('round-trips a string scalar through the sqlite codec', () => {
    expect(SQLITE_SQL.decodeJson<string>(SQLITE_SQL.encodeJson('manual'))).toBe('manual');
  });
});

describeEachDialect('jsonField', (ctx) => {
  it('extracts a top-level property from a JSON column', async () => {
    await sql`CREATE TABLE json_probe (id integer, doc ${sql.raw(ctx.sqlHelper.json())})`.execute(
      ctx.db,
    );
    await sql`INSERT INTO json_probe (id, doc) VALUES (1, '{"colour":"red"}')`.execute(ctx.db);

    // json_probe is a fixture, not part of the Database interface, so this
    // query goes through raw SQL rather than the typed builder.
    const result = await sql<{ colour: string | null }>`
      SELECT ${ctx.sqlHelper.jsonField('doc', 'colour')} AS colour FROM json_probe
    `.execute(ctx.db);

    expect(result.rows[0]?.colour).toBe('red');
  });
});
