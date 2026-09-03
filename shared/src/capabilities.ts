import type { FacetId } from './facets.js';

export type IntegrationScope = 'cluster' | 'node';

/**
 * `unknown` is not an error state to hide. A cluster that denies a probe must
 * never be reported as "you do not run this" — silent blindness is worse than a
 * visible gap.
 */
export type IntegrationState = 'present' | 'absent' | 'unknown';

export type IntegrationOverride = 'auto' | 'force_on' | 'force_off';

/** A product is installed, but something kubitor needs from it is not working. */
export interface DegradedReason {
  facet: FacetId;
  reason: string;
}

export interface IntegrationStatus {
  id: string;
  title: string;
  scope: IntegrationScope;
  state: IntegrationState;
  version?: string;
  /** Human-readable justification, e.g. "DaemonSet kube-system/cilium". */
  evidence: string;
  unknownReason?: 'rbac' | 'error';
  override: IntegrationOverride;
  facets: FacetId[];
  degraded: DegradedReason[];
}

export type NavCategory =
  | 'overview'
  | 'infrastructure'
  | 'network'
  | 'storage'
  | 'delivery'
  | 'hosts'
  | 'security'
  | 'settings';

export interface NavEntry {
  id: string;
  title: string;
  category: NavCategory;
  href: string;
  requiresFacet?: FacetId;
  order?: number;
}

export interface FacetAvailability {
  enabled: boolean;
  /** Integration ids currently feeding this facet. */
  sources: string[];
  /** Integrations that would feed it but cannot right now. */
  degradedBy?: string[];
}

export interface AgentStatus {
  installed: boolean;
  reporting: number;
  expected: number;
  /** Nodes whose agent has stopped reporting. */
  stale: string[];
}

export interface CapabilityManifest {
  generatedAt: number;
  /**
   * kubitor's own build, which is not the cluster's version.
   *
   * They were shown in the same place once, and a Kubernetes version rendered
   * beside the product name reads as the product's version.
   */
  kubitor: { version: string };
  cluster: { version: string; nodes: number };
  agent: AgentStatus;
  integrations: IntegrationStatus[];
  facets: Partial<Record<FacetId, FacetAvailability>>;
  nav: NavEntry[];
}
