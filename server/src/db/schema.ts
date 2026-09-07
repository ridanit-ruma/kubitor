import type { Generated } from 'kysely';
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
  /** `admin`, `operator` or `viewer`. */
  role: string;
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
  | 'delete'
  | 'set_role';

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

export interface FacetNodesTable {
  observed_at: number;
  integration: string;
  name: string;
  roles: string;
  ready: number;
  kubelet_version: string;
  os_image: string;
  architecture: string;
  capacity_cpu_milli: number;
  capacity_memory_bytes: number;
  capacity_pods: number;
  allocatable_cpu_milli: number;
  allocatable_memory_bytes: number;
  allocatable_pods: number;
  created_at: number;
  attrs: string;
}

export interface FacetWorkloadsTable {
  observed_at: number;
  integration: string;
  namespace: string;
  name: string;
  kind: string;
  node: string | null;
  phase: string;
  /** `CrashLoopBackOff`, `ImagePullBackOff` — why it is not running. */
  reason: string | null;
  ready: number;
  restarts: number;
  images: string;
  owner_kind: string | null;
  owner_name: string | null;
  created_at: number;
  attrs: string;
}

export interface FacetEventsTable {
  at: number;
  integration: string;
  namespace: string;
  kind: string;
  name: string;
  reason: string;
  message: string;
  type: string;
  count: number;
  attrs: string;
}

export interface NodeSamplesTable {
  at: number;
  node: string;
  cpu_nano_cores: number | null;
  memory_working_set: number | null;
  fs_used: number | null;
  fs_capacity: number | null;
  net_rx: number | null;
  net_tx: number | null;
}

export interface AgentTokensTable {
  node: string;
  token_hash: string;
  created_at: number;
  last_seen_at: number | null;
}

export interface FacetHostHardwareTable {
  at: number;
  integration: string;
  node: string;
  cpu_mhz: number | null;
  cpu_percent: number | null;
  gpu_mhz: number | null;
  mem_used_bytes: number | null;
  net_rx_bytes_per_second: number | null;
  net_tx_bytes_per_second: number | null;
  temps: string;
  attrs: string;
}

export interface FacetHostResourcesTable {
  observed_at: number;
  integration: string;
  node: string;
  cpu_model: string | null;
  cpu_cores: number | null;
  cpu_percent: number | null;
  cpu_mhz_avg: number | null;
  cpu_mhz_max: number | null;
  load1: number | null;
  load5: number | null;
  load15: number | null;
  mem_total_bytes: number | null;
  mem_available_bytes: number | null;
  mem_used_bytes: number | null;
  mem_cached_bytes: number | null;
  swap_total_bytes: number | null;
  swap_used_bytes: number | null;
  gpus: string;
  disks: string;
  cpu: string;
  memory_modules: string;
  memory_slots: number | null;
  sensors: string;
  nics: string;
  block_devices: string;
  attrs: string;
}

/** One attempt at a backup, successful or not. */
export interface BackupsTable {
  id: string;
  started_at: number;
  finished_at: number | null;
  /** The object's key in the bucket, once there is one. */
  key: string | null;
  bytes: number | null;
  /** 0 or 1. */
  encrypted: number;
  /** 0 or 1: read back from the bucket and opened. */
  verified: number;
  /** 0 or 1. */
  ok: number;
  error: string | null;
}

/** One thing that is wrong, from the moment it is noticed until it clears. */
export interface AlertsTable {
  id: string;
  rule: string;
  subject: string;
  severity: string;
  summary: string;
  detail: string | null;
  /** `pending` while damping, `firing` once it has held long enough. */
  state: string;
  seen_count: number;
  missing_count: number;
  first_seen_at: number;
  last_seen_at: number;
  fired_at: number | null;
  resolved_at: number | null;
  attrs: string;
}

/** One message to one channel, from queued to delivered or abandoned. */
export interface NotificationsTable {
  /** Monotonic, and the delivery order. Generated by the database. */
  seq: Generated<number>;
  alert_id: string;
  channel: string;
  kind: string;
  created_at: number;
  attempts: number;
  next_attempt_at: number;
  /** Set once the queue is done with it, delivered or abandoned. */
  finished_at: number | null;
  /** 0 or 1; only meaningful once finished. */
  delivered: number;
  error: string | null;
}

/** One attempt to log in, successful or not. */
export interface FacetHostAccessTable {
  at: number;
  integration: string;
  node: string;
  outcome: string;
  method: string;
  user: string;
  client_ip: string;
  client_port: number | null;
  sshd_pid: number | null;
  attrs: string;
}

/** One session that is open right now. */
export interface FacetHostSessionsTable {
  observed_at: number;
  integration: string;
  node: string;
  user: string;
  tty: string | null;
  kind: string;
  pid: number;
  since: number;
  from_ip: string | null;
  attrs: string;
}

/** One command seen inside a session. */
export interface FacetHostCommandsTable {
  at: number;
  integration: string;
  node: string;
  session_pid: number | null;
  user: string;
  pid: number;
  comm: string;
  argv: string;
  /** `sampled` or `audit`; the difference between "missed it" and "it did not happen". */
  source: string;
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
  facet_nodes: FacetNodesTable;
  facet_workloads: FacetWorkloadsTable;
  facet_events: FacetEventsTable;
  node_samples: NodeSamplesTable;
  agent_tokens: AgentTokensTable;
  facet_host_hardware: FacetHostHardwareTable;
  facet_host_resources: FacetHostResourcesTable;
  backups: BackupsTable;
  alerts: AlertsTable;
  notifications: NotificationsTable;
  facet_host_access: FacetHostAccessTable;
  facet_host_sessions: FacetHostSessionsTable;
  facet_host_commands: FacetHostCommandsTable;
}
