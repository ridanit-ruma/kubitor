/**
 * Storage conventions, applied to every table in this file:
 *
 * - Timestamps are epoch milliseconds in an integer column, never a
 *   dialect-native datetime type.
 * - Booleans are 0/1 in an integer column.
 * - Surrogate keys are application-generated text UUIDs, never database
 *   sequences, so inserts are identical across dialects.
 */

/** Key/value configuration. Values are JSON documents. */
export interface SettingsTable {
  key: string;
  value: string;
  updated_at: number;
}

export interface AccountsTable {
  id: string;
  username: string;
  password_hash: string;
  /** 0 or 1. */
  must_change_password: number;
  created_at: number;
  disabled_at: number | null;
}

export interface SessionsTable {
  id: string;
  account_id: string;
  created_at: number;
  expires_at: number;
  last_seen_at: number;
}

export type LoginOutcome = 'ok' | 'bad_password' | 'unknown_user' | 'locked';

export interface LoginAttemptsTable {
  at: number;
  ip: string;
  username: string;
  outcome: string;
}

export type AccountAction =
  | 'login'
  | 'logout'
  | 'change_password'
  | 'create'
  | 'reset_password'
  | 'delete';

export interface AccountEventsTable {
  at: number;
  actor_id: string | null;
  action: string;
  subject: string;
  detail: string;
}

/** Every table kubitor stores. Later plans extend this interface. */
export interface Database {
  settings: SettingsTable;
  accounts: AccountsTable;
  sessions: SessionsTable;
  login_attempts: LoginAttemptsTable;
  account_events: AccountEventsTable;
}
