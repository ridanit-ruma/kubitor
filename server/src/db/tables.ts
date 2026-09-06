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
  /**
   * A column that is null while the row is still live.
   *
   * An event table's rows are usually finished the moment they are written, so
   * age alone decides. Not always: an alert that has been firing for longer
   * than the retention window is the one most worth keeping, and sweeping it
   * would make it fire again as though it were new. Rows whose column here is
   * null are left alone whatever their age.
   */
  liveWhileNull?: string;
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
  { name: 'agent_tokens', kind: 'state' },
  { name: 'facet_host_hardware', kind: 'event', timeColumn: 'at', retentionMs: 7 * DAY_MS },
  { name: 'facet_host_resources', kind: 'state' },
  // A year of attempts. One row per backup, so this is hundreds of rows even
  // at an hourly schedule — the retention is here because every growing table
  // declares one, not because this one threatens the volume.
  { name: 'backups', kind: 'event', timeColumn: 'started_at', retentionMs: 365 * DAY_MS },
  // Long enough to answer "has this happened before", short enough that a
  // flapping pod cannot fill the volume with its own history.
  {
    name: 'alerts',
    kind: 'event',
    timeColumn: 'first_seen_at',
    retentionMs: 90 * DAY_MS,
    // An alert that is still firing is never old enough to forget.
    liveWhileNull: 'resolved_at',
  },
  {
    name: 'notifications',
    kind: 'event',
    timeColumn: 'created_at',
    retentionMs: 30 * DAY_MS,
    // A message still waiting to be delivered is not old news, however long
    // the channel has been unreachable. One that was abandoned is finished and
    // ages out like anything else.
    liveWhileNull: 'finished_at',
  },
];

/** Kysely's own migration tables, which the registry does not govern. */
export const MIGRATION_BOOKKEEPING_TABLES: readonly string[] = [
  DEFAULT_MIGRATION_TABLE,
  DEFAULT_MIGRATION_LOCK_TABLE,
];
