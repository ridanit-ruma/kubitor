import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe } from 'vitest';
import { createDb } from '../db/connect.js';
import { type DialectKind, type DialectSql, POSTGRES_SQL, SQLITE_SQL } from '../db/dialect.js';
import type { Database } from '../db/schema.js';

export interface DialectContext {
  readonly kind: DialectKind;
  readonly sqlHelper: DialectSql;
  /** Assigned in beforeAll; read it inside `it`, never at describe time. */
  db: Kysely<Database>;
}

/**
 * Runs a suite once per available dialect. PostgreSQL participates only when
 * TEST_POSTGRES_URL is set — CI sets it, local runs cover SQLite alone.
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

    beforeAll(() => {
      ctx.db = createDb({ kind: 'postgres', postgresUrl: postgresUrl as string });
    });

    afterAll(async () => {
      await ctx.db.destroy();
    });

    suite(ctx);
  });
}
