import { FACET_KIND, type FacetId, type FacetKind } from '@kubitor/shared';
import { z } from 'zod';

/**
 * How a facet is stored.
 *
 * The pipeline reads descriptors rather than knowing facets by name, so adding
 * a facet is a descriptor plus a migration — never new pipeline code.
 */
export interface FacetDescriptor {
  id: FacetId;
  kind: FacetKind;
  table: string;
  /** Epoch-ms column: `at` for event facets, `observed_at` for state facets. */
  timeColumn: string;
  /** Columns encoded with the dialect's JSON codec on write. */
  jsonColumns: readonly string[];
  /** How long event rows survive; unused for state facets. */
  retentionMs?: number;
  schema: z.ZodType<Record<string, unknown>>;
}

const DAY_MS = 86_400_000;

/** Strings are truncated rather than rejected — see the sanitize-and-keep rule. */
export const MAX_TEXT = 1024;
const text = (max = 256) => z.string().max(max);

const attrs = z.record(z.string(), z.unknown()).default({});

const httpAccess = z.object({
  at: z.number().int(),
  node: text(253).nullish(),
  host: text(253),
  method: text(16),
  path: text(MAX_TEXT),
  status: z.number().int().min(0).max(999),
  duration_ms: z.number().int().min(0),
  client_ip: text(64),
  user_agent: text(MAX_TEXT).nullish(),
  route: text(253).nullish(),
  service: text(253).nullish(),
  bytes_out: z.number().int().min(0).nullish(),
  attrs,
});

const httpRoutes = z.object({
  observed_at: z.number().int(),
  kind: text(64),
  namespace: text(253),
  name: text(253),
  host: text(253),
  path: text(MAX_TEXT),
  service: text(253),
  port: z.number().int().min(0).max(65535).nullish(),
  tls: z.number().int().min(0).max(1),
  class: text(253).nullish(),
  attrs,
});

const nodes = z.object({
  observed_at: z.number().int(),
  name: text(253),
  roles: text(MAX_TEXT),
  ready: z.number().int().min(0).max(1),
  kubelet_version: text(64),
  os_image: text(MAX_TEXT),
  architecture: text(32),
  capacity_cpu_milli: z.number().int().min(0),
  capacity_memory_bytes: z.number().int().min(0),
  capacity_pods: z.number().int().min(0),
  allocatable_cpu_milli: z.number().int().min(0),
  allocatable_memory_bytes: z.number().int().min(0),
  allocatable_pods: z.number().int().min(0),
  created_at: z.number().int(),
  attrs,
});

const workloads = z.object({
  observed_at: z.number().int(),
  namespace: text(253),
  name: text(253),
  kind: text(64),
  node: text(253).nullish(),
  phase: text(32),
  ready: z.number().int().min(0).max(1),
  restarts: z.number().int().min(0),
  images: text(MAX_TEXT),
  owner_kind: text(64).nullish(),
  owner_name: text(253).nullish(),
  created_at: z.number().int(),
  attrs,
});

const events = z.object({
  at: z.number().int(),
  namespace: text(253),
  kind: text(64),
  name: text(253),
  reason: text(128),
  message: text(MAX_TEXT),
  type: text(32),
  count: z.number().int().min(0),
  attrs,
});

const hostHardware = z.object({
  at: z.number().int(),
  node: text(253),
  cpu_mhz: z.number().int().min(0).nullish(),
  cpu_percent: z.number().min(0).max(100).nullish(),
  gpu_mhz: z.number().int().min(0).nullish(),
  /** Host RAM in use, which is not the kubelet's container working set. */
  mem_used_bytes: z.number().int().min(0).nullish(),
  /** Measured on the host, so it moves at the rate the dashboard claims. */
  net_rx_bytes_per_second: z.number().min(0).nullish(),
  net_tx_bytes_per_second: z.number().min(0).nullish(),
  /** Sensor label to degrees Celsius. A sensor that cannot be read is absent. */
  temps: z.record(z.string(), z.number()).default({}),
  attrs,
});

/**
 * What the machine is, as opposed to what it is doing.
 *
 * A state facet: one row per node, replaced on every sync. Totals live here so
 * a screen never has to infer capacity from a percentage, which is how RAM and
 * disk end up looking like each other.
 */
const hostResources = z.object({
  observed_at: z.number().int(),
  node: text(253),
  cpu_model: text(MAX_TEXT).nullish(),
  cpu_cores: z.number().int().min(0).nullish(),
  cpu_percent: z.number().min(0).max(100).nullish(),
  cpu_mhz_avg: z.number().int().min(0).nullish(),
  cpu_mhz_max: z.number().int().min(0).nullish(),
  load1: z.number().min(0).nullish(),
  load5: z.number().min(0).nullish(),
  load15: z.number().min(0).nullish(),
  mem_total_bytes: z.number().int().min(0).nullish(),
  mem_available_bytes: z.number().int().min(0).nullish(),
  mem_used_bytes: z.number().int().min(0).nullish(),
  mem_cached_bytes: z.number().int().min(0).nullish(),
  swap_total_bytes: z.number().int().min(0).nullish(),
  swap_used_bytes: z.number().int().min(0).nullish(),
  /** `{name, driver, mhzCur, mhzMax, busyPercent, memTotal, memUsed, celsius}` */
  gpus: z.array(z.record(z.string(), z.unknown())).default([]),
  /** `{mount, device, fsType, totalBytes, usedBytes}` */
  disks: z.array(z.record(z.string(), z.unknown())).default([]),
  /** Topology, caches and notable instruction sets. */
  cpu: z.record(z.string(), z.unknown()).nullish(),
  /** One entry per populated memory slot. */
  memory_modules: z.array(z.record(z.string(), z.unknown())).max(64).default([]),
  /** Physical interfaces with their link and their throughput. */
  nics: z.array(z.record(z.string(), z.unknown())).max(64).default([]),
  /** Whole disks, with what they are and what they are doing. */
  block_devices: z.array(z.record(z.string(), z.unknown())).max(64).default([]),
  attrs,
});

export const FACET_DESCRIPTORS: readonly FacetDescriptor[] = [
  {
    id: 'host.hardware',
    kind: 'event',
    table: 'facet_host_hardware',
    timeColumn: 'at',
    jsonColumns: ['temps', 'attrs'],
    retentionMs: 7 * DAY_MS,
    schema: hostHardware,
  },
  {
    id: 'host.resources',
    kind: 'state',
    table: 'facet_host_resources',
    timeColumn: 'observed_at',
    jsonColumns: ['gpus', 'disks', 'cpu', 'memory_modules', 'nics', 'block_devices', 'attrs'],
    schema: hostResources,
  },
  {
    id: 'nodes',
    kind: 'state',
    table: 'facet_nodes',
    timeColumn: 'observed_at',
    jsonColumns: ['attrs'],
    schema: nodes,
  },
  {
    id: 'workloads',
    kind: 'state',
    table: 'facet_workloads',
    timeColumn: 'observed_at',
    jsonColumns: ['attrs'],
    schema: workloads,
  },
  {
    id: 'events',
    kind: 'event',
    table: 'facet_events',
    timeColumn: 'at',
    jsonColumns: ['attrs'],
    retentionMs: 7 * DAY_MS,
    schema: events,
  },
  {
    id: 'http.access',
    kind: 'event',
    table: 'facet_http_access',
    timeColumn: 'at',
    jsonColumns: ['attrs'],
    retentionMs: 14 * DAY_MS,
    schema: httpAccess,
  },
  {
    id: 'http.routes',
    kind: 'state',
    table: 'facet_http_routes',
    timeColumn: 'observed_at',
    jsonColumns: ['attrs'],
    schema: httpRoutes,
  },
];

const BY_ID = new Map(FACET_DESCRIPTORS.map((descriptor) => [descriptor.id, descriptor]));

export function facetDescriptor(id: string): FacetDescriptor | undefined {
  return BY_ID.get(id as FacetId);
}

/** Facets that have a storage descriptor. Others are declared but not yet stored. */
export function storedFacets(): readonly FacetId[] {
  return FACET_DESCRIPTORS.map((descriptor) => descriptor.id);
}

export function facetKindMatchesShared(descriptor: FacetDescriptor): boolean {
  return FACET_KIND[descriptor.id] === descriptor.kind;
}
