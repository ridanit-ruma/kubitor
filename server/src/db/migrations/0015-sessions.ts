import type { Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';
import type { DialectSql } from '../dialect.js';

/**
 * Who tried to get in, and who is in.
 *
 * Two tables because they are two things. An attempt happened and is a log
 * line forever; a session is happening and stops. Storing them together would
 * mean a table where half the columns are null in half the rows, and a screen
 * that has to ask which kind each row is before it can render it.
 */
export function sessionsMigration(dialect: DialectSql): Migration {
  return {
    async up(db: Kysely<unknown>): Promise<void> {
      await db.schema
        .createTable('facet_host_access')
        .addColumn('at', dialect.timestampMs(), (c) => c.notNull())
        .addColumn('integration', 'text', (c) => c.notNull())
        .addColumn('node', 'text', (c) => c.notNull())
        // accepted | failed | invalid_user | disconnected. `invalid_user` is
        // separate because guessing at account names is a different event from
        // getting your own password wrong.
        .addColumn('outcome', 'text', (c) => c.notNull())
        .addColumn('method', 'text', (c) => c.notNull())
        .addColumn('user', 'text', (c) => c.notNull())
        .addColumn('client_ip', 'text', (c) => c.notNull())
        .addColumn('client_port', 'integer')
        .addColumn('sshd_pid', 'integer')
        .addColumn('attrs', dialect.json(), (c) => c.notNull())
        .execute();

      await db.schema
        .createIndex('facet_host_access_at')
        .on('facet_host_access')
        .column('at')
        .execute();

      // The query the screen leads with: who has been failing, from where.
      await db.schema
        .createIndex('facet_host_access_client')
        .on('facet_host_access')
        .columns(['client_ip', 'at'])
        .execute();

      await db.schema
        .createTable('facet_host_sessions')
        .addColumn('observed_at', dialect.timestampMs(), (c) => c.notNull())
        .addColumn('integration', 'text', (c) => c.notNull())
        .addColumn('node', 'text', (c) => c.notNull())
        .addColumn('user', 'text', (c) => c.notNull())
        .addColumn('tty', 'text')
        // shell | exec | sftp | forward. A list of login shells alone would
        // miss most of what automation does over ssh.
        .addColumn('kind', 'text', (c) => c.notNull())
        .addColumn('pid', 'integer', (c) => c.notNull())
        .addColumn('since', dialect.timestampMs(), (c) => c.notNull())
        /** The address, where a log reader was able to supply one. */
        .addColumn('from_ip', 'text')
        .addColumn('attrs', dialect.json(), (c) => c.notNull())
        .execute();

      await db.schema
        .createIndex('facet_host_sessions_node')
        .on('facet_host_sessions')
        .columns(['node', 'pid'])
        .execute();
    },

    async down(db: Kysely<unknown>): Promise<void> {
      await db.schema.dropTable('facet_host_sessions').execute();
      await db.schema.dropTable('facet_host_access').execute();
    },
  };
}
