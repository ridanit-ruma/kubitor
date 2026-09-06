import type { Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';
import type { DialectSql } from '../dialect.js';

/**
 * What is wrong, as a thing with a name rather than a count.
 *
 * The overview already counts not-ready nodes and troubled pods, per request,
 * keeping nothing. That is enough to draw a screen and not enough to tell
 * anybody: without an identity there is no way to know whether a condition is
 * news, and every evaluation would be a fresh message.
 *
 * `(rule, subject)` is that identity — `pod-crashloop` on
 * `kubitor/kubitor-server-7d9`. One row lives per identity until it resolves;
 * a later recurrence is a new row, so the history is a history.
 */
export function alertsMigration(dialect: DialectSql): Migration {
  return {
    async up(db: Kysely<unknown>): Promise<void> {
      await db.schema
        .createTable('alerts')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('rule', 'text', (c) => c.notNull())
        .addColumn('subject', 'text', (c) => c.notNull())
        .addColumn('severity', 'text', (c) => c.notNull())
        .addColumn('summary', 'text', (c) => c.notNull())
        .addColumn('detail', 'text')
        // `pending` while damping, `firing` once it has held long enough.
        // A resolved alert keeps its last state and gains `resolved_at`.
        .addColumn('state', 'text', (c) => c.notNull())
        /* Consecutive evaluations the condition has held, and has not. Stored
         * rather than kept in memory so a restart mid-flap does not re-fire
         * something that was already reported. */
        .addColumn('seen_count', 'integer', (c) => c.notNull().defaultTo(0))
        .addColumn('missing_count', 'integer', (c) => c.notNull().defaultTo(0))
        .addColumn('first_seen_at', dialect.timestampMs(), (c) => c.notNull())
        .addColumn('last_seen_at', dialect.timestampMs(), (c) => c.notNull())
        .addColumn('fired_at', dialect.timestampMs())
        .addColumn('resolved_at', dialect.timestampMs())
        .addColumn('attrs', dialect.json(), (c) => c.notNull())
        .execute();

      // The lookup every evaluation makes: the open alert for this identity.
      await db.schema
        .createIndex('alerts_rule_subject')
        .on('alerts')
        .columns(['rule', 'subject', 'resolved_at'])
        .execute();

      await db.schema
        .createIndex('alerts_first_seen_at')
        .on('alerts')
        .column('first_seen_at')
        .execute();
    },

    async down(db: Kysely<unknown>): Promise<void> {
      await db.schema.dropTable('alerts').execute();
    },
  };
}
