import type { Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';
import type { DialectSql } from '../dialect.js';

export function settingsMigration(dialect: DialectSql): Migration {
  return {
    async up(db: Kysely<unknown>): Promise<void> {
      await db.schema
        .createTable('settings')
        .addColumn('key', 'text', (c) => c.primaryKey())
        .addColumn('value', dialect.json(), (c) => c.notNull())
        .addColumn('updated_at', dialect.timestampMs(), (c) => c.notNull())
        .execute();
    },

    async down(db: Kysely<unknown>): Promise<void> {
      await db.schema.dropTable('settings').execute();
    },
  };
}
