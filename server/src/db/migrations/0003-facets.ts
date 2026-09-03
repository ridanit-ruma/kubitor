import type { Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';
import type { DialectSql } from '../dialect.js';

/**
 * Facet tables plus the record of what detection last concluded.
 *
 * Every facet row carries `integration` so a snapshot can be replaced for one
 * source without touching another's rows, and so a screen can say where a
 * number came from.
 */
export function facetsMigration(dialect: DialectSql): Migration {
  return {
    async up(db: Kysely<unknown>): Promise<void> {
      await db.schema
        .createTable('integration_state')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('state', 'text', (c) => c.notNull())
        .addColumn('version', 'text')
        .addColumn('evidence', 'text', (c) => c.notNull())
        .addColumn('unknown_reason', 'text')
        .addColumn('override', 'text', (c) => c.notNull())
        .addColumn('degraded', dialect.json(), (c) => c.notNull())
        .addColumn('checked_at', dialect.timestampMs(), (c) => c.notNull())
        .execute();

      await db.schema
        .createTable('facet_http_access')
        .addColumn('at', dialect.timestampMs(), (c) => c.notNull())
        .addColumn('integration', 'text', (c) => c.notNull())
        .addColumn('node', 'text')
        .addColumn('host', 'text', (c) => c.notNull())
        .addColumn('method', 'text', (c) => c.notNull())
        .addColumn('path', 'text', (c) => c.notNull())
        .addColumn('status', 'integer', (c) => c.notNull())
        .addColumn('duration_ms', 'integer', (c) => c.notNull())
        .addColumn('client_ip', 'text', (c) => c.notNull())
        .addColumn('user_agent', 'text')
        .addColumn('route', 'text')
        .addColumn('service', 'text')
        .addColumn('bytes_out', 'integer')
        .addColumn('attrs', dialect.json(), (c) => c.notNull())
        .execute();

      await db.schema
        .createIndex('facet_http_access_at')
        .on('facet_http_access')
        .column('at')
        .execute();
      await db.schema
        .createIndex('facet_http_access_integration_at')
        .on('facet_http_access')
        .columns(['integration', 'at'])
        .execute();

      await db.schema
        .createTable('facet_http_routes')
        .addColumn('observed_at', dialect.timestampMs(), (c) => c.notNull())
        .addColumn('integration', 'text', (c) => c.notNull())
        .addColumn('kind', 'text', (c) => c.notNull())
        .addColumn('namespace', 'text', (c) => c.notNull())
        .addColumn('name', 'text', (c) => c.notNull())
        .addColumn('host', 'text', (c) => c.notNull())
        .addColumn('path', 'text', (c) => c.notNull())
        .addColumn('service', 'text', (c) => c.notNull())
        .addColumn('port', 'integer')
        .addColumn('tls', 'integer', (c) => c.notNull())
        .addColumn('class', 'text')
        .addColumn('attrs', dialect.json(), (c) => c.notNull())
        .execute();

      await db.schema
        .createIndex('facet_http_routes_integration')
        .on('facet_http_routes')
        .column('integration')
        .execute();
    },

    async down(db: Kysely<unknown>): Promise<void> {
      await db.schema.dropTable('facet_http_routes').execute();
      await db.schema.dropTable('facet_http_access').execute();
      await db.schema.dropTable('integration_state').execute();
    },
  };
}
