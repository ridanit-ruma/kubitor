import type { Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';
import type { DialectSql } from '../dialect.js';

/**
 * What a machine is made of.
 *
 * Four documents rather than forty columns: a CPU's caches, a memory
 * controller's slots, an interface's counters and a disk's link are lists whose
 * length is a property of the hardware. Flattening them would mean a migration
 * every time a node has one more DIMM than the last one did.
 */
export function hostInventoryMigration(dialect: DialectSql): Migration {
  return {
    async up(db: Kysely<unknown>): Promise<void> {
      for (const column of ['cpu', 'memory_modules', 'nics', 'block_devices']) {
        await db.schema
          .alterTable('facet_host_resources')
          .addColumn(column, dialect.json())
          .execute();
      }

      await db.schema
        .alterTable('facet_host_hardware')
        .addColumn('net_rx_bytes_per_second', dialect.bigInt())
        .execute();
      await db.schema
        .alterTable('facet_host_hardware')
        .addColumn('net_tx_bytes_per_second', dialect.bigInt())
        .execute();
    },

    async down(db: Kysely<unknown>): Promise<void> {
      for (const column of ['net_tx_bytes_per_second', 'net_rx_bytes_per_second']) {
        await db.schema.alterTable('facet_host_hardware').dropColumn(column).execute();
      }
      for (const column of ['block_devices', 'nics', 'memory_modules', 'cpu']) {
        await db.schema.alterTable('facet_host_resources').dropColumn(column).execute();
      }
    },
  };
}
