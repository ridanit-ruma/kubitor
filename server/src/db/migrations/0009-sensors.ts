import type { Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';
import type { DialectSql } from '../dialect.js';

/**
 * Sensors with the device they belong to, and the slot count behind the modules.
 *
 * A flat `chip.label` record cannot tell two NVMe drives apart — both call
 * their chip `nvme` — so one drive's temperature replaced the other's, and
 * neither could be shown beside the disk it describes.
 */
export function sensorsMigration(dialect: DialectSql): Migration {
  return {
    async up(db: Kysely<unknown>): Promise<void> {
      await db.schema
        .alterTable('facet_host_resources')
        .addColumn('sensors', dialect.json())
        .execute();
      await db.schema
        .alterTable('facet_host_resources')
        .addColumn('memory_slots', 'integer')
        .execute();
    },

    async down(db: Kysely<unknown>): Promise<void> {
      await db.schema.alterTable('facet_host_resources').dropColumn('memory_slots').execute();
      await db.schema.alterTable('facet_host_resources').dropColumn('sensors').execute();
    },
  };
}
