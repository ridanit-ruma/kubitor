import type { Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';
import type { DialectSql } from '../dialect.js';

/**
 * What happened to each backup, including the ones that failed.
 *
 * A backup feature whose failures leave no trace is the canonical disaster: the
 * job stopped six weeks ago, nothing said so, and the discovery is made on the
 * day it was needed. Every attempt writes a row, and a row is only `ok` once
 * the object has been read back and opened.
 */
export function backupsMigration(dialect: DialectSql): Migration {
  return {
    async up(db: Kysely<unknown>): Promise<void> {
      await db.schema
        .createTable('backups')
        .addColumn('id', 'text', (column) => column.primaryKey())
        .addColumn('started_at', dialect.timestampMs(), (column) => column.notNull())
        .addColumn('finished_at', dialect.timestampMs())
        .addColumn('key', 'text')
        .addColumn('bytes', dialect.bigInt())
        // 0 or 1. The screen has to say which, because "encrypted" is the
        // difference between a bucket leak and an incident.
        .addColumn('encrypted', 'integer', (column) => column.notNull().defaultTo(0))
        .addColumn('verified', 'integer', (column) => column.notNull().defaultTo(0))
        .addColumn('ok', 'integer', (column) => column.notNull().defaultTo(0))
        .addColumn('error', 'text')
        .execute();

      await db.schema
        .createIndex('backups_started_at')
        .on('backups')
        .column('started_at')
        .execute();
    },

    async down(db: Kysely<unknown>): Promise<void> {
      await db.schema.dropTable('backups').execute();
    },
  };
}
