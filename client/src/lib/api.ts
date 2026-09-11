import type {
  BackupInput,
  BackupView,
  CapabilityManifest,
  NotifyInput,
  NotifyView,
} from '@kubitor/shared';
import type { SensorReading } from './sensors';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(status: number, code?: string) {
    super(code ?? `Request failed with ${status}`);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

/**
 * Every request carries the session cookie and nothing else.
 *
 * The token is HttpOnly, so there is no header to attach and no value for a
 * script — including this one — to read.
 */
async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: 'include',
    headers: { 'content-type': 'application/json', ...init.headers },
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(response.status, body.error);
  }

  return response.status === 204 ? (undefined as T) : ((await response.json()) as T);
}

export const api = {
  login: (username: string, password: string) =>
    request<{ username: string; mustChangePassword: boolean }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),

  logout: () => request<void>('/api/auth/logout', { method: 'POST' }),

  me: () => request<{ username: string; mustChangePassword: boolean }>('/api/auth/me'),

  changePassword: (currentPassword: string, newPassword: string) =>
    request<void>('/api/auth/change-password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword, newPassword }),
    }),

  capabilities: () => request<CapabilityManifest>('/api/capabilities'),

  overview: () => request<ClusterSummary>('/api/overview'),

  /** The cluster's throughput over a window, as the database kept it. */
  overviewSeries: (minutes: number) =>
    request<{ points: ClusterTrafficPoint[] }>(`/api/overview/series?minutes=${minutes}`),

  rescan: () => request<CapabilityManifest>('/api/capabilities/rescan', { method: 'POST' }),

  setOverride: (id: string, override: 'auto' | 'force_on' | 'force_off') =>
    request<void>(`/api/integrations/${encodeURIComponent(id)}/override`, {
      method: 'POST',
      body: JSON.stringify({ override }),
    }),

  currentMetrics: () =>
    request<{ generatedAt: number; nodes: LiveNodeMetrics[] }>('/api/metrics/current'),

  facet: (facet: string, query: URLSearchParams) =>
    request<{ rows: Record<string, unknown>[]; total: number }>(
      `/api/facets/${facet}?${query.toString()}`,
    ),

  series: (node: string, minutes: number) =>
    request<{ node: string; points: SeriesPoint[]; rates: RatePoint[]; host: HostSeriesPoint[] }>(
      `/api/nodes/${encodeURIComponent(node)}/series?minutes=${minutes}`,
    ),

  /** The agent's snapshot for one node, or an empty list where none reports. */
  hostResources: (node: string) =>
    request<{ rows: HostResourcesRow[]; total: number }>(
      `/api/facets/resources?node=${encodeURIComponent(node)}&limit=1`,
    ),

  accounts: () => request<{ accounts: AccountSummary[] }>('/api/accounts'),

  createAccount: (username: string, role: Role, currentPassword: string) =>
    request<{ account: AccountSummary; password: string }>('/api/accounts', {
      method: 'POST',
      body: JSON.stringify({ username, role, currentPassword }),
    }),

  setAccountRole: (id: string, role: Role, currentPassword: string) =>
    request<{ account: AccountSummary }>(`/api/accounts/${encodeURIComponent(id)}/role`, {
      method: 'POST',
      body: JSON.stringify({ role, currentPassword }),
    }),

  resetAccount: (id: string, currentPassword: string) =>
    request<{ password: string }>(`/api/accounts/${encodeURIComponent(id)}/reset-password`, {
      method: 'POST',
      body: JSON.stringify({ currentPassword }),
    }),

  deleteAccount: (id: string, currentPassword: string) =>
    request<void>(`/api/accounts/${encodeURIComponent(id)}/delete`, {
      method: 'POST',
      body: JSON.stringify({ currentPassword }),
    }),

  agents: () => request<{ agents: AgentSummary[] }>('/api/agents'),

  /** The plaintext comes back once; only its hash is stored. */
  issueAgent: (name: string, currentPassword: string) =>
    request<{ name: string; token: string }>('/api/agents', {
      method: 'POST',
      body: JSON.stringify({ name, currentPassword }),
    }),

  revokeAgent: (name: string, currentPassword: string) =>
    request<void>(`/api/agents/${encodeURIComponent(name)}/revoke`, {
      method: 'POST',
      body: JSON.stringify({ currentPassword }),
    }),

  alerts: () => request<AlertsPage>('/api/alerts'),

  backups: () => request<BackupStatus>('/api/backups'),

  runBackup: (currentPassword: string) =>
    request<{ ok: boolean; key?: string; bytes?: number; error?: string }>('/api/backups/run', {
      method: 'POST',
      body: JSON.stringify({ currentPassword }),
    }),

  notifySettings: () => request<NotifyView>('/api/settings/notify'),

  saveNotifySettings: (input: NotifyInput) =>
    request<{ changed: string[] }>('/api/settings/notify', {
      method: 'PUT',
      body: JSON.stringify(input),
    }),

  /** One message, now, so a wrong webhook fails here instead of at 3am. */
  testNotifyChannel: (channel: string) =>
    request<{ ok: boolean; error?: string }>('/api/settings/notify/test', {
      method: 'POST',
      body: JSON.stringify({ channel }),
    }),

  backupSettings: () => request<BackupView>('/api/settings/backup'),

  saveBackupSettings: (input: BackupInput, currentPassword: string) =>
    request<{ changed: string[] }>('/api/settings/backup', {
      method: 'PUT',
      body: JSON.stringify({ ...input, currentPassword }),
    }),
};

/**
 * One thing that is wrong, from when it was noticed until it cleared.
 *
 * `rule` and `subject` together are its identity, which is why a recurrence is
 * a second record rather than a revived first one.
 */
export interface AlertRecord {
  id: string;
  rule: string;
  subject: string;
  severity: 'critical' | 'warning';
  summary: string;
  detail: string | null;
  /** `pending` means seen but not yet held long enough to be anybody's problem. */
  state: 'pending' | 'firing';
  firstSeenAt: number;
  lastSeenAt: number;
  firedAt: number | null;
  resolvedAt: number | null;
  attrs: Record<string, unknown>;
}

/** One message to one channel, from queued to delivered or abandoned. */
export interface QueuedNotification {
  seq: number;
  alertId: string;
  channel: string;
  kind: 'fired' | 'resolved';
  createdAt: number;
  attempts: number;
  finishedAt: number | null;
  delivered: boolean;
  error: string | null;
}

export interface AlertsPage {
  firing: AlertRecord[];
  recent: AlertRecord[];
  /** Whether anything is being told, and whether it is getting through. */
  delivery: { configured: boolean; pending: number; recent: QueuedNotification[] };
}

/** One attempt at a backup, successful or not. */
export interface BackupRecord {
  id: string;
  startedAt: number;
  finishedAt: number | null;
  key: string | null;
  bytes: number | null;
  encrypted: boolean;
  /** Read back out of the bucket and opened. */
  verified: boolean;
  ok: boolean;
  error: string | null;
}

export type BackupStatus =
  | { configured: false; backups: [] }
  | {
      configured: true;
      bucket: string;
      endpoint: string;
      /** `write-only` means kubitor cannot read back what it wrote. */
      encryption: 'none' | 'write-only' | 'readable';
      /**
       * Whether this bucket's own secret key is stored unencrypted in the
       * database — which is the file being uploaded to it.
       */
      secretsInTheClear: boolean;
      schedule: string;
      nextRunAt: number | null;
      newestVerifiedAt: number | null;
      running: boolean;
      backups: BackupRecord[];
    };

/** A credential for an agent that cannot present a service-account token. */
export interface AgentSummary {
  name: string;
  createdAt: number;
  lastSeenAt: number | null;
  /** Also a Kubernetes node, so this is a second way to report as one. */
  isNode: boolean;
}

/** The export link is a plain href so the browser handles the download. */
export function exportHref(facet: string, query: URLSearchParams, format: 'json' | 'csv'): string {
  const params = new URLSearchParams(query);
  params.set('format', format);
  return `/api/export/${facet}?${params.toString()}`;
}

/**
 * The cluster in the numbers an overview answers with.
 *
 * Counted by the server across every row, not by tallying a page of workloads
 * in the browser — which would have made "how many pods are running" a
 * question about the first hundred.
 */
export interface ClusterSummary {
  nodes: { total: number; ready: number };
  pods: {
    total: number;
    running: number;
    pending: number;
    succeeded: number;
    failed: number;
    /** Running, without every container in them being ready. */
    degraded: number;
    /** Why pods are not running, worst first. */
    troubled: { reason: string; count: number }[];
  };
  capacity: { cpuMilli: number; memoryBytes: number; pods: number };
  /** Warning events in the last hour. */
  warnings: number;
}

/** One instant of cluster-wide throughput, summed across the nodes. */
export interface ClusterTrafficPoint {
  at: number;
  rxBytesPerSecond: number | null;
  txBytesPerSecond: number | null;
}

export interface LiveNodeMetrics {
  node: string;
  sampledAt: number;
  cpuMilli: number | null;
  cpuPercent: number | null;
  memoryBytes: number | null;
  memoryPercent: number | null;
  fsUsedBytes: number | null;
  fsPercent: number | null;
  capacityCpuMilli: number | null;
  capacityMemoryBytes: number | null;
  fsCapacityBytes: number | null;
  netRxBytesPerSecond: number | null;
  netTxBytesPerSecond: number | null;
  /**
   * The kubelet reports this machine, so it belongs to the cluster.
   *
   * False for a machine only the agent knows about. Anything said about the
   * cluster as a whole has to leave those out.
   */
  clusterNode: boolean;
  /** Present only on machines running the agent. */
  host?: LiveHostMetrics;
}

/** What the agent adds: the host as the kernel sees it, once a second. */
export interface LiveHostMetrics {
  sampledAt: number;
  cpuPercent: number | null;
  cpuMhzAverage: number | null;
  cpuMhzMax: number | null;
  cpuCores: number | null;
  load1: number | null;
  memTotalBytes: number | null;
  memUsedBytes: number | null;
  memAvailableBytes: number | null;
  memPercent: number | null;
  swapTotalBytes: number | null;
  swapUsedBytes: number | null;
  gpuMhz: number | null;
  netRxBytesPerSecond: number | null;
  netTxBytesPerSecond: number | null;
  hottestCelsius: number | null;
}

/**
 * One node's devices as the agent last saw them, carried by the socket.
 *
 * The same shapes the stored snapshot holds, so a screen reads one type
 * whichever source answered — the difference is only how old it is.
 */
export interface LiveHostDetail {
  node: string;
  sampledAt: number;
  sensors: SensorReading[];
  nics: NicInfo[];
  blockDevices: BlockDevice[];
  gpus: GpuInfo[];
}

export interface GpuInfo {
  card: string;
  driver: string | null;
  pciId: string | null;
  vendor: string | null;
  linkSpeed: string | null;
  linkWidth: number | null;
  mhzCur: number | null;
  mhzMax: number | null;
  memMhzCur: number | null;
  memMhzMax: number | null;
  busyPercent: number | null;
  memTotalBytes: number | null;
  memUsedBytes: number | null;
  /** True when the GPU has no memory of its own and uses system RAM. */
  memShared: boolean;
}

export interface DiskInfo {
  mount: string;
  device: string;
  fsType: string;
  totalBytes: number;
  usedBytes: number;
  /** What an unprivileged process may still write — not total less used. */
  availableBytes?: number;
}

export interface CpuCache {
  level: number;
  type: string;
  /** The machine's total at this level, across every instance of it. */
  sizeBytes: number;
  instances: number;
}

export interface CpuDetail {
  vendor: string | null;
  model: string | null;
  sockets: number | null;
  coresPerSocket: number | null;
  threads: number | null;
  family: number | null;
  modelNumber: number | null;
  stepping: number | null;
  microcode: string | null;
  governor: string | null;
  features: string[];
  caches: CpuCache[];
}

export interface MemoryModule {
  slot: string;
  sizeBytes: number;
  type: string | null;
  width: string | null;
  /** Firmware only. Null on a machine where the kernel had to answer. */
  formFactor: string | null;
  speedMts: number | null;
  configuredSpeedMts: number | null;
  manufacturer: string | null;
  partNumber: string | null;
  rank: number | null;
}

export interface NicInfo {
  name: string;
  speedMbps: number | null;
  mtu: number | null;
  state: string | null;
  macAddress: string | null;
  rxBytesPerSecond: number | null;
  txBytesPerSecond: number | null;
  rxErrors: number;
  txErrors: number;
  rxDropped: number;
  txDropped: number;
}

export interface BlockDevice {
  name: string;
  model: string | null;
  sizeBytes: number | null;
  rotational: boolean | null;
  linkSpeed: string | null;
  linkWidth: number | null;
  schedulerQueue: string | null;
  readBytesPerSecond: number | null;
  writeBytesPerSecond: number | null;
  readsPerSecond: number | null;
  writesPerSecond: number | null;
}

export interface HostResourcesRow extends Record<string, unknown> {
  observed_at: number;
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
  gpus: GpuInfo[];
  disks: DiskInfo[];
  cpu: CpuDetail | null;
  memory_modules: MemoryModule[];
  memory_slots: number | null;
  sensors: SensorReading[];
  nics: NicInfo[];
  block_devices: BlockDevice[];
}

export interface SeriesPoint {
  at: number;
  cpuMilli: number | null;
  memoryBytes: number | null;
  fsUsedBytes: number | null;
  fsCapacityBytes: number | null;
  netRxBytes: number | null;
  netTxBytes: number | null;
}

export interface RatePoint {
  at: number;
  netRxBytesPerSecond: number | null;
  netTxBytesPerSecond: number | null;
}

/**
 * What the agent measured, over time.
 *
 * The same quantities the node cards show, so a chart and the figure above it
 * are the same measurement rather than two views that nearly agree.
 */
export interface HostSeriesPoint {
  at: number;
  cpuPercent: number | null;
  memUsedBytes: number | null;
  netRxBytesPerSecond: number | null;
  netTxBytesPerSecond: number | null;
}

/**
 * What an account may do.
 *
 * `viewer` reads the cluster. `operator` also changes what is installed on it.
 * `admin` also reaches the credentials and the people — agent tokens, the
 * backup bucket, and accounts.
 */
export type Role = 'admin' | 'operator' | 'viewer';

export interface AccountSummary {
  id: string;
  username: string;
  role: Role;
  mustChangePassword: boolean;
  createdAt: number;
}
