import type { Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';
import type { DialectSql } from '../dialect.js';

/**
 * Per-node ingest tokens and the facet the agent feeds.
 *
 * Tokens are per node, not shared. A single cluster-wide token would let any
 * node forge readings for any other, and a compromised node could then fabricate
 * a healthy-looking fleet.
 */
export function agentMigration(dialect: DialectSql): Migration {
  return {
    async up(db: Kysely<unknown>): Promise<void> {
      await db.schema
        .createTable('agent_tokens')
        .addColumn('node', 'text', (c) => c.primaryKey())
        .addColumn('token_hash', 'text', (c) => c.notNull())
        .addColumn('created_at', dialect.timestampMs(), (c) => c.notNull())
        .addColumn('last_seen_at', dialect.timestampMs())
        .execute();

      await db.schema
        .createTable('facet_host_hardware')
        .addColumn('at', dialect.timestampMs(), (c) => c.notNull())
        .addColumn('integration', 'text', (c) => c.notNull())
        .addColumn('node', 'text', (c) => c.notNull())
        .addColumn('cpu_mhz', 'integer')
        .addColumn('temps', dialect.json(), (c) => c.notNull())
        .addColumn('attrs', dialect.json(), (c) => c.notNull())
        .execute();

      await db.schema
        .createIndex('facet_host_hardware_node_at')
        .on('facet_host_hardware')
        .columns(['node', 'at'])
        .execute();
    },

    async down(db: Kysely<unknown>): Promise<void> {
      await db.schema.dropTable('facet_host_hardware').execute();
      await db.schema.dropTable('agent_tokens').execute();
    },
  };
}
