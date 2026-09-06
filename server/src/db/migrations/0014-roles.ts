import type { Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';
import type { DialectSql } from '../dialect.js';

/**
 * What an account is allowed to do.
 *
 * Every account was equal, which was defensible while kubitor only read the
 * cluster. It stopped being defensible the moment there were screens that mint
 * agent credentials and hold a bucket's keys — and it will be indefensible when
 * there is a record of what colleagues typed.
 *
 * Existing accounts become `admin`, so an install that upgrades into this keeps
 * working exactly as it did. Narrowing anybody is then a deliberate act rather
 * than a surprise.
 */
export function rolesMigration(_dialect: DialectSql): Migration {
  return {
    async up(db: Kysely<unknown>): Promise<void> {
      await db.schema
        .alterTable('accounts')
        .addColumn('role', 'text', (c) => c.notNull().defaultTo('admin'))
        .execute();
    },

    async down(db: Kysely<unknown>): Promise<void> {
      await db.schema.alterTable('accounts').dropColumn('role').execute();
    },
  };
}
