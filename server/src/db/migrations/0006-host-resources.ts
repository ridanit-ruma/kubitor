import type { Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';
import type { DialectSql } from '../dialect.js';

/**
 * What the agent can see that the API server cannot.
 *
 * `facet_host_resources` is a state facet — one row per node, replaced on every
 * sync — because totals are facts about the machine, not a time series. The
 * columns added to `facet_host_hardware` are the opposite: values worth charting
 * over time.
 */
export function hostResourcesMigration(dialect: DialectSql): Migration {
  return {
    async up(db: Kysely<unknown>): Promise<void> {
      await db.schema.alterTable('facet_host_hardware').addColumn('gpu_mhz', 'integer').execute();
      await db.schema
        .alterTable('facet_host_hardware')
        .addColumn('mem_used_bytes', dialect.bigInt())
        .execute();

      await db.schema
        .createTable('facet_host_resources')
        .addColumn('observed_at', dialect.timestampMs(), (c) => c.notNull())
        .addColumn('integration', 'text', (c) => c.notNull())
        .addColumn('node', 'text', (c) => c.notNull())
        .addColumn('cpu_model', 'text')
        .addColumn('cpu_cores', 'integer')
        .addColumn('cpu_mhz_avg', 'integer')
        .addColumn('cpu_mhz_max', 'integer')
        .addColumn('load1', 'real')
        .addColumn('load5', 'real')
        .addColumn('load15', 'real')
        .addColumn('mem_total_bytes', dialect.bigInt())
        .addColumn('mem_available_bytes', dialect.bigInt())
        .addColumn('mem_used_bytes', dialect.bigInt())
        .addColumn('mem_cached_bytes', dialect.bigInt())
        .addColumn('swap_total_bytes', dialect.bigInt())
        .addColumn('swap_used_bytes', dialect.bigInt())
        .addColumn('gpus', dialect.json(), (c) => c.notNull())
        .addColumn('disks', dialect.json(), (c) => c.notNull())
        .addColumn('attrs', dialect.json(), (c) => c.notNull())
        .execute();

      await db.schema
        .createIndex('facet_host_resources_node')
        .on('facet_host_resources')
        .column('node')
        .execute();
    },

    async down(db: Kysely<unknown>): Promise<void> {
      await db.schema.dropTable('facet_host_resources').execute();
      await db.schema.alterTable('facet_host_hardware').dropColumn('mem_used_bytes').execute();
      await db.schema.alterTable('facet_host_hardware').dropColumn('gpu_mhz').execute();
    },
  };
}
