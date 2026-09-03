import { type Kysely, sql } from 'kysely';
import type { Database } from './schema.js';
import type { TableSpec } from './tables.js';

/**
 * Deletes rows older than each event table's retention window.
 *
 * Takes the specs rather than importing TABLES so callers can sweep a subset
 * and so tests can drive it with a synthetic table.
 *
 * Returns the number of rows deleted per table.
 */
export async function sweepRetention(
  db: Kysely<Database>,
  specs: readonly TableSpec[],
  now: number,
): Promise<Record<string, number>> {
  const deleted: Record<string, number> = {};

  for (const spec of specs) {
    if (spec.kind !== 'event') continue;
    if (!spec.timeColumn || !spec.retentionMs) {
      throw new Error(`Event table ${spec.name} is missing a retention policy`);
    }

    const cutoff = now - spec.retentionMs;
    const result = await sql`
      DELETE FROM ${sql.table(spec.name)} WHERE ${sql.ref(spec.timeColumn)} < ${cutoff}
    `.execute(db);

    deleted[spec.name] = Number(result.numAffectedRows ?? 0n);
  }

  return deleted;
}
