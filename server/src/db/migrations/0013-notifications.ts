import type { Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';
import type { DialectSql } from '../dialect.js';

/**
 * What has been sent, what is waiting, and what could not be sent at all.
 *
 * A queue rather than a direct call, because delivery is the unreliable part
 * of this and the least important: a rate-limited webhook or a server restart
 * must not lose an alert, and a failing channel must never be able to slow the
 * evaluation that produced it.
 *
 * The key is a sequence rather than a uuid, and that is load-bearing. Order of
 * delivery has to be order of occurrence — a recovery arriving before the
 * failure it recovered from is worse than either arriving late — and a batch of
 * transitions is queued inside one millisecond, so `created_at` ties and cannot
 * order them. A monotonic counter can, and survives a restart doing it.
 */
export function notificationsMigration(dialect: DialectSql): Migration {
  return {
    async up(db: Kysely<unknown>): Promise<void> {
      let table = db.schema.createTable('notifications');

      table =
        dialect.kind === 'sqlite'
          ? table.addColumn('seq', 'integer', (c) => c.primaryKey().autoIncrement())
          : table.addColumn('seq', 'serial', (c) => c.primaryKey());

      await table
        .addColumn('alert_id', 'text', (c) => c.notNull())
        .addColumn('channel', 'text', (c) => c.notNull())
        // `fired` or `resolved`. Both are sent; a channel that only ever
        // reported bad news is one people learn to ignore.
        .addColumn('kind', 'text', (c) => c.notNull())
        .addColumn('created_at', dialect.timestampMs(), (c) => c.notNull())
        .addColumn('attempts', 'integer', (c) => c.notNull().defaultTo(0))
        /* When the next attempt is due. Backoff is a time, not a sleep: the
         * process may restart between attempts and the queue has to survive
         * that without either forgetting or hammering. */
        .addColumn('next_attempt_at', dialect.timestampMs(), (c) => c.notNull())
        /* Set when the message stops being the queue's problem, whether it was
         * delivered or abandoned. One column for both, because "is this
         * finished" is one question, and asking it of two nullable columns is
         * how an abandoned message ends up living forever. */
        .addColumn('finished_at', dialect.timestampMs())
        // 0 or 1, and only meaningful once finished.
        .addColumn('delivered', 'integer', (c) => c.notNull().defaultTo(0))
        .addColumn('error', 'text')
        .execute();

      await db.schema
        .createIndex('notifications_pending')
        .on('notifications')
        .columns(['finished_at', 'next_attempt_at'])
        .execute();
    },

    async down(db: Kysely<unknown>): Promise<void> {
      await db.schema.dropTable('notifications').execute();
    },
  };
}
