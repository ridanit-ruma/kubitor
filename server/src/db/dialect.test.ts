import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';
import { describeEachDialect } from '../test/db-harness.js';
import { decodeJson, POSTGRES_SQL, SQLITE_SQL } from './dialect.js';

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

describe('decodeJson', () => {
  it('parses the string sqlite hands back', () => {
    expect(decodeJson<{ a: number }>('{"a":1}')).toEqual({ a: 1 });
  });

  it('passes through the object the postgres driver already parsed', () => {
    expect(decodeJson<{ a: number }>({ a: 1 })).toEqual({ a: 1 });
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
