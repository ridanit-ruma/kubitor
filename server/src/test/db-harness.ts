import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { type Kysely, sql } from 'kysely';
import { afterAll, beforeAll, describe } from 'vitest';
import { createDb } from '../db/connect.js';
import { type DialectKind, type DialectSql, POSTGRES_SQL, SQLITE_SQL } from '../db/dialect.js';
import type { Database } from '../db/schema.js';

export interface DialectContext {
  readonly kind: DialectKind;
  readonly sqlHelper: DialectSql;
  /** Assigned in beforeAll; read it inside `it`, never at describe time. */
  db: Kysely<Database>;
  /**
   * The PostgreSQL schema this suite owns, or undefined on SQLite where the
   * whole file belongs to the suite. Tests that introspect the database must
   * filter by it.
   */
  schema?: string;
}

/**
 * Table names visible to this suite alone.
 *
 * PostgreSQL introspection reports every user schema in the database, so a
 * suite that asked for "all tables" would see the fixtures of every other
 * suite sharing the CI database. Filtering by the suite's own schema restores
 * the isolation SQLite gets from a private file.
 */
export async function listOwnTables(ctx: DialectContext): Promise<string[]> {
  const tables = await ctx.db.introspection.getTables();
  return tables
    .filter((table) => ctx.schema === undefined || table.schema === ctx.schema)
    .map((table) => table.name);
}

/**
 * Runs a suite once per available dialect. PostgreSQL participates only when
 * TEST_POSTGRES_URL is set — CI sets it, local runs cover SQLite alone.
 *
 * Each suite gets its own database: a private file on SQLite, a private schema
 * on PostgreSQL. Without that, fixture tables one suite creates would be
 * visible to another, and the shared PostgreSQL database would behave
 * differently from the per-suite SQLite files.
 */
export function describeEachDialect(name: string, suite: (ctx: DialectContext) => void): void {
  const postgresUrl = process.env.TEST_POSTGRES_URL;

  describe(`${name} [sqlite]`, () => {
    const ctx = { kind: 'sqlite', sqlHelper: SQLITE_SQL } as DialectContext;
    let directory: string;

    beforeAll(() => {
      // Keep the file off tmpfs: SQLite reports disk I/O errors there under
      // memory pressure on this workstation.
      directory = mkdtempSync(join(process.cwd(), '.tmptest', 'db-'));
      ctx.db = createDb({ kind: 'sqlite', sqlitePath: join(directory, 'test.db') });
    });

    afterAll(async () => {
      await ctx.db.destroy();
      rmSync(directory, { recursive: true, force: true });
    });

    suite(ctx);
  });

  describe.skipIf(!postgresUrl)(`${name} [postgres]`, () => {
    const ctx = { kind: 'postgres', sqlHelper: POSTGRES_SQL } as DialectContext;
    const schema = `t_${randomUUID().replaceAll('-', '')}`;
    const url = postgresUrl as string;

    beforeAll(async () => {
      const bootstrap = createDb({ kind: 'postgres', postgresUrl: url });
      await sql`CREATE SCHEMA IF NOT EXISTS ${sql.id(schema)}`.execute(bootstrap);
      await bootstrap.destroy();

      ctx.schema = schema;
      ctx.db = createDb({ kind: 'postgres', postgresUrl: url, postgresSchema: schema });
    });

    afterAll(async () => {
      await ctx.db.destroy();

      const cleanup = createDb({ kind: 'postgres', postgresUrl: url });
      await sql`DROP SCHEMA IF EXISTS ${sql.id(schema)} CASCADE`.execute(cleanup);
      await cleanup.destroy();
    });

    suite(ctx);
  });
}
