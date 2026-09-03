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

export interface IntegrationStateTable {
  id: string;
  state: string;
  version: string | null;
  evidence: string;
  unknown_reason: string | null;
  override: string;
  degraded: string;
  checked_at: number;
}

export interface FacetHttpAccessTable {
  at: number;
  integration: string;
  node: string | null;
  host: string;
  method: string;
  path: string;
  status: number;
  duration_ms: number;
  client_ip: string;
  user_agent: string | null;
  route: string | null;
  service: string | null;
  bytes_out: number | null;
  attrs: string;
}

export interface FacetHttpRoutesTable {
  observed_at: number;
  integration: string;
  kind: string;
  namespace: string;
  name: string;
  host: string;
  path: string;
  service: string;
  port: number | null;
  tls: number;
  class: string | null;
  attrs: string;
}

/** Every table kubitor stores. Later plans extend this interface. */
export interface Database {
  settings: SettingsTable;
  accounts: AccountsTable;
  sessions: SessionsTable;
  login_attempts: LoginAttemptsTable;
  account_events: AccountEventsTable;
  integration_state: IntegrationStateTable;
  facet_http_access: FacetHttpAccessTable;
  facet_http_routes: FacetHttpRoutesTable;
}
