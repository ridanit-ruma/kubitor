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
const DAY_MS = 86_400_000;

export const TABLES: readonly TableSpec[] = [
  { name: 'settings', kind: 'config' },
  { name: 'accounts', kind: 'state' },
  { name: 'sessions', kind: 'state' },
  // Only needed long enough to enforce the lockout window.
  { name: 'login_attempts', kind: 'event', timeColumn: 'at', retentionMs: DAY_MS },
  { name: 'account_events', kind: 'event', timeColumn: 'at', retentionMs: 90 * DAY_MS },
  { name: 'integration_state', kind: 'state' },
  { name: 'facet_http_access', kind: 'event', timeColumn: 'at', retentionMs: 14 * DAY_MS },
  { name: 'facet_http_routes', kind: 'state' },
  { name: 'facet_nodes', kind: 'state' },
  { name: 'facet_workloads', kind: 'state' },
  { name: 'facet_events', kind: 'event', timeColumn: 'at', retentionMs: 7 * DAY_MS },
  { name: 'node_samples', kind: 'event', timeColumn: 'at', retentionMs: 7 * DAY_MS },
];

/** Kysely's own migration tables, which the registry does not govern. */
export const MIGRATION_BOOKKEEPING_TABLES: readonly string[] = [
  DEFAULT_MIGRATION_TABLE,
  DEFAULT_MIGRATION_LOCK_TABLE,
];
