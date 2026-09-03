/** Vendor-neutral concepts that screens read. Screens never read vendors. */
export const FACET_IDS = [
  'nodes',
  'workloads',
  'events',
  'http.access',
  'http.routes',
  'tls.certificates',
  'storage.volumes',
  'network.flows',
  'gitops.sync',
  'host.hardware',
  'host.resources',
  'host.sessions',
  'security.alerts',
] as const;

export type FacetId = (typeof FACET_IDS)[number];

/**
 * Event facets are append-only, time-indexed and pruned by retention.
 * State facets are snapshots keyed by identity: a sync replaces them, and rows
 * missing from that sync are deleted.
 */
export type FacetKind = 'event' | 'state';

export const FACET_KIND: Record<FacetId, FacetKind> = {
  nodes: 'state',
  workloads: 'state',
  events: 'event',
  'http.access': 'event',
  'http.routes': 'state',
  'tls.certificates': 'state',
  'storage.volumes': 'state',
  'network.flows': 'event',
  'gitops.sync': 'state',
  'host.hardware': 'event',
  'host.resources': 'state',
  'host.sessions': 'event',
  'security.alerts': 'event',
};
