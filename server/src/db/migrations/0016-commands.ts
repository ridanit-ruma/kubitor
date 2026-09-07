import type { Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';
import type { DialectSql } from '../dialect.js';

/**
 * What was run inside a session.
 *
 * `source` is the load-bearing column. Sampling /proc once a second misses
 * anything shorter than a second, which is most commands; auditd sees every
 * `execve` and misses nothing. A row that did not say which it came from would
 * let an operator read absences as evidence, and absences from a sampler are
 * evidence of nothing.
 */
export function commandsMigration(dialect: DialectSql): Migration {
  return {
    async up(db: Kysely<unknown>): Promise<void> {
      await db.schema
        .createTable('facet_host_commands')
        .addColumn('at', dialect.timestampMs(), (c) => c.notNull())
        .addColumn('integration', 'text', (c) => c.notNull())
        .addColumn('node', 'text', (c) => c.notNull())
        .addColumn('session_pid', 'integer')
        .addColumn('user', 'text', (c) => c.notNull())
        .addColumn('pid', 'integer', (c) => c.notNull())
        .addColumn('comm', 'text', (c) => c.notNull())
        /* Redacted on the machine before it was sent. Empty in comm-only mode,
         * which exists for anybody who would rather not trust a pattern list. */
        .addColumn('argv', 'text', (c) => c.notNull())
        // `sampled` or `audit`.
        .addColumn('source', 'text', (c) => c.notNull())
        .addColumn('attrs', dialect.json(), (c) => c.notNull())
        .execute();

      await db.schema
        .createIndex('facet_host_commands_at')
        .on('facet_host_commands')
        .column('at')
        .execute();

      // The query the session detail makes: what ran in this one.
      await db.schema
        .createIndex('facet_host_commands_session')
        .on('facet_host_commands')
        .columns(['node', 'session_pid', 'at'])
        .execute();
    },

    async down(db: Kysely<unknown>): Promise<void> {
      await db.schema.dropTable('facet_host_commands').execute();
    },
  };
}
