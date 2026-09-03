import type { Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';
import type { DialectSql } from '../dialect.js';

/**
 * Identity columns are application-generated text UUIDs rather than database
 * sequences: `serial` and `AUTOINCREMENT` are the one schema divergence Kysely
 * cannot paper over, and avoiding it keeps every insert identical.
 *
 * Booleans are 0/1 integers for the same reason timestamps are epoch-ms
 * integers — one representation, both dialects.
 */
export function authMigration(dialect: DialectSql): Migration {
  return {
    async up(db: Kysely<unknown>): Promise<void> {
      await db.schema
        .createTable('accounts')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('username', 'text', (c) => c.notNull().unique())
        .addColumn('password_hash', 'text', (c) => c.notNull())
        .addColumn('must_change_password', 'integer', (c) => c.notNull())
        .addColumn('created_at', dialect.timestampMs(), (c) => c.notNull())
        .addColumn('disabled_at', dialect.timestampMs())
        .execute();

      await db.schema
        .createTable('sessions')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('account_id', 'text', (c) =>
          c.notNull().references('accounts.id').onDelete('cascade'),
        )
        .addColumn('created_at', dialect.timestampMs(), (c) => c.notNull())
        .addColumn('expires_at', dialect.timestampMs(), (c) => c.notNull())
        .addColumn('last_seen_at', dialect.timestampMs(), (c) => c.notNull())
        .execute();

      await db.schema
        .createIndex('sessions_account_id')
        .on('sessions')
        .column('account_id')
        .execute();
      await db.schema
        .createIndex('sessions_expires_at')
        .on('sessions')
        .column('expires_at')
        .execute();

      await db.schema
        .createTable('login_attempts')
        .addColumn('at', dialect.timestampMs(), (c) => c.notNull())
        .addColumn('ip', 'text', (c) => c.notNull())
        .addColumn('username', 'text', (c) => c.notNull())
        .addColumn('outcome', 'text', (c) => c.notNull())
        .execute();

      await db.schema
        .createIndex('login_attempts_ip_at')
        .on('login_attempts')
        .columns(['ip', 'at'])
        .execute();

      await db.schema
        .createTable('account_events')
        .addColumn('at', dialect.timestampMs(), (c) => c.notNull())
        .addColumn('actor_id', 'text')
        .addColumn('action', 'text', (c) => c.notNull())
        .addColumn('subject', 'text', (c) => c.notNull())
        .addColumn('detail', dialect.json(), (c) => c.notNull())
        .execute();

      await db.schema.createIndex('account_events_at').on('account_events').column('at').execute();
    },

    async down(db: Kysely<unknown>): Promise<void> {
      await db.schema.dropTable('account_events').execute();
      await db.schema.dropTable('login_attempts').execute();
      await db.schema.dropTable('sessions').execute();
      await db.schema.dropTable('accounts').execute();
    },
  };
}
