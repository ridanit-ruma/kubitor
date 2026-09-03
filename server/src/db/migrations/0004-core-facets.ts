import type { Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';
import type { DialectSql } from '../dialect.js';

/**
 * The facets that exist on every cluster, filled from the Kubernetes API and
 * the kubelet — no exporters, no Prometheus, nothing to install.
 *
 * Samples are stored raw rather than rolled up. At a 15 s cadence a week of one
 * node is roughly forty thousand rows, which SQLite handles without help;
 * rollups become worth their complexity at a scale kubitor does not yet target.
 */
export function coreFacetsMigration(dialect: DialectSql): Migration {
  return {
    async up(db: Kysely<unknown>): Promise<void> {
      await db.schema
        .createTable('facet_nodes')
        .addColumn('observed_at', dialect.timestampMs(), (c) => c.notNull())
        .addColumn('integration', 'text', (c) => c.notNull())
        .addColumn('name', 'text', (c) => c.notNull())
        .addColumn('roles', 'text', (c) => c.notNull())
        .addColumn('ready', 'integer', (c) => c.notNull())
        .addColumn('kubelet_version', 'text', (c) => c.notNull())
        .addColumn('os_image', 'text', (c) => c.notNull())
        .addColumn('architecture', 'text', (c) => c.notNull())
        .addColumn('capacity_cpu_milli', 'integer', (c) => c.notNull())
        .addColumn('capacity_memory_bytes', dialect.bigInt(), (c) => c.notNull())
        .addColumn('capacity_pods', 'integer', (c) => c.notNull())
        .addColumn('allocatable_cpu_milli', 'integer', (c) => c.notNull())
        .addColumn('allocatable_memory_bytes', dialect.bigInt(), (c) => c.notNull())
        .addColumn('allocatable_pods', 'integer', (c) => c.notNull())
        .addColumn('created_at', dialect.timestampMs(), (c) => c.notNull())
        .addColumn('attrs', dialect.json(), (c) => c.notNull())
        .execute();

      await db.schema
        .createTable('facet_workloads')
        .addColumn('observed_at', dialect.timestampMs(), (c) => c.notNull())
        .addColumn('integration', 'text', (c) => c.notNull())
        .addColumn('namespace', 'text', (c) => c.notNull())
        .addColumn('name', 'text', (c) => c.notNull())
        .addColumn('kind', 'text', (c) => c.notNull())
        .addColumn('node', 'text')
        .addColumn('phase', 'text', (c) => c.notNull())
        .addColumn('ready', 'integer', (c) => c.notNull())
        .addColumn('restarts', 'integer', (c) => c.notNull())
        .addColumn('images', 'text', (c) => c.notNull())
        .addColumn('owner_kind', 'text')
        .addColumn('owner_name', 'text')
        .addColumn('created_at', dialect.timestampMs(), (c) => c.notNull())
        .addColumn('attrs', dialect.json(), (c) => c.notNull())
        .execute();

      await db.schema
        .createIndex('facet_workloads_namespace')
        .on('facet_workloads')
        .column('namespace')
        .execute();
      await db.schema
        .createIndex('facet_workloads_node')
        .on('facet_workloads')
        .column('node')
        .execute();

      await db.schema
        .createTable('facet_events')
        .addColumn('at', dialect.timestampMs(), (c) => c.notNull())
        .addColumn('integration', 'text', (c) => c.notNull())
        .addColumn('namespace', 'text', (c) => c.notNull())
        .addColumn('kind', 'text', (c) => c.notNull())
        .addColumn('name', 'text', (c) => c.notNull())
        .addColumn('reason', 'text', (c) => c.notNull())
        .addColumn('message', 'text', (c) => c.notNull())
        .addColumn('type', 'text', (c) => c.notNull())
        .addColumn('count', 'integer', (c) => c.notNull())
        .addColumn('attrs', dialect.json(), (c) => c.notNull())
        .execute();

      await db.schema.createIndex('facet_events_at').on('facet_events').column('at').execute();

      await db.schema
        .createTable('node_samples')
        .addColumn('at', dialect.timestampMs(), (c) => c.notNull())
        .addColumn('node', 'text', (c) => c.notNull())
        .addColumn('cpu_nano_cores', dialect.bigInt())
        .addColumn('memory_working_set', dialect.bigInt())
        .addColumn('fs_used', dialect.bigInt())
        .addColumn('fs_capacity', dialect.bigInt())
        .addColumn('net_rx', dialect.bigInt())
        .addColumn('net_tx', dialect.bigInt())
        .execute();

      await db.schema
        .createIndex('node_samples_node_at')
        .on('node_samples')
        .columns(['node', 'at'])
        .execute();
    },

    async down(db: Kysely<unknown>): Promise<void> {
      await db.schema.dropTable('node_samples').execute();
      await db.schema.dropTable('facet_events').execute();
      await db.schema.dropTable('facet_workloads').execute();
      await db.schema.dropTable('facet_nodes').execute();
    },
  };
}
