import type { CapabilityManifest } from '@kubitor/shared';

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
    request<{ node: string; points: SeriesPoint[]; rates: RatePoint[] }>(
      `/api/nodes/${encodeURIComponent(node)}/series?minutes=${minutes}`,
    ),

  /** The agent's snapshot for one node, or an empty list where none reports. */
  hostResources: (node: string) =>
    request<{ rows: HostResourcesRow[]; total: number }>(
      `/api/facets/resources?node=${encodeURIComponent(node)}&limit=1`,
    ),

  accounts: () => request<{ accounts: AccountSummary[] }>('/api/accounts'),

  createAccount: (username: string, currentPassword: string) =>
    request<{ account: AccountSummary; password: string }>('/api/accounts', {
      method: 'POST',
      body: JSON.stringify({ username, currentPassword }),
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
};

/** The export link is a plain href so the browser handles the download. */
export function exportHref(facet: string, query: URLSearchParams, format: 'json' | 'csv'): string {
  const params = new URLSearchParams(query);
  params.set('format', format);
  return `/api/export/${facet}?${params.toString()}`;
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
  /** Present only on nodes running the agent. */
  host?: LiveHostMetrics;
}

/** What the agent adds: the host as the kernel sees it, once a second. */
export interface LiveHostMetrics {
  sampledAt: number;
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
  hottestCelsius: number | null;
}

export interface GpuInfo {
  card: string;
  driver: string | null;
  pciId: string | null;
  mhzCur: number | null;
  mhzMax: number | null;
  busyPercent: number | null;
  memTotalBytes: number | null;
  memUsedBytes: number | null;
}

export interface DiskInfo {
  mount: string;
  device: string;
  fsType: string;
  totalBytes: number;
  usedBytes: number;
}

export interface HostResourcesRow extends Record<string, unknown> {
  observed_at: number;
  node: string;
  cpu_model: string | null;
  cpu_cores: number | null;
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

export interface AccountSummary {
  id: string;
  username: string;
  mustChangePassword: boolean;
  createdAt: number;
}
