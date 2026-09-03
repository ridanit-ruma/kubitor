import type { Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';
import type { DialectSql } from '../dialect.js';

/**
 * How busy a host is, as a percentage the agent measured itself.
 *
 * The kubelet reports millicores against a declared capacity, which needs the
 * capacity beside it to mean anything and only moves as fast as the kubelet
 * samples. `/proc/stat` gives the figure directly, once a second.
 */
export function cpuUtilizationMigration(_dialect: DialectSql): Migration {
  return {
    async up(db: Kysely<unknown>): Promise<void> {
      await db.schema.alterTable('facet_host_resources').addColumn('cpu_percent', 'real').execute();
      await db.schema.alterTable('facet_host_hardware').addColumn('cpu_percent', 'real').execute();
    },

    async down(db: Kysely<unknown>): Promise<void> {
      await db.schema.alterTable('facet_host_hardware').dropColumn('cpu_percent').execute();
      await db.schema.alterTable('facet_host_resources').dropColumn('cpu_percent').execute();
    },
  };
}
