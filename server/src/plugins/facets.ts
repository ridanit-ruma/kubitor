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

export const FACET_DESCRIPTORS: readonly FacetDescriptor[] = [
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
