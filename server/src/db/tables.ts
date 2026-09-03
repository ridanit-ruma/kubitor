import { DEFAULT_MIGRATION_LOCK_TABLE, DEFAULT_MIGRATION_TABLE } from 'kysely/migration';

/**
 * `config` tables hold a bounded set of rows. `state` tables are snapshots
 * replaced on every sync. `event` tables grow forever unless pruned, so they
 * must declare where their time lives and how long it stays.
 */
export type TableKind = 'config' | 'state' | 'event';

export interface TableSpec {
  name: string;
  kind: TableKind;
  /** Epoch-millisecond column. Required for event tables. */
  timeColumn?: string;
  /** How long rows survive. Required for event tables. */
  retentionMs?: number;
}

/**
 * Every table kubitor owns. A migration that creates a table without adding it
 * here fails `tables.test.ts` — that is the point.
 */
export const TABLES: readonly TableSpec[] = [{ name: 'settings', kind: 'config' }];

/** Kysely's own migration tables, which the registry does not govern. */
export const MIGRATION_BOOKKEEPING_TABLES: readonly string[] = [
  DEFAULT_MIGRATION_TABLE,
  DEFAULT_MIGRATION_LOCK_TABLE,
];
