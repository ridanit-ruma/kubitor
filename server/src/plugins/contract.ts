import type {
  DegradedReason,
  FacetId,
  IntegrationScope,
  IntegrationState,
  NavEntry,
} from '@kubitor/shared';

/** A Kubernetes verb set an integration needs, aggregated into the ClusterRole. */
export interface RbacRule {
  apiGroups: readonly string[];
  resources: readonly string[];
  verbs: readonly string[];
}

/**
 * What a probe can conclude.
 *
 * `unknown` exists because a cluster that denies a probe must never be reported
 * as "you do not run this" — silent blindness is worse than a visible gap.
 */
export type Detection =
  | { state: 'present'; version?: string; evidence: string; degraded?: readonly DegradedReason[] }
  | { state: 'absent'; evidence: string }
  | { state: 'unknown'; reason: 'rbac' | 'error'; evidence: string };

export interface WorkloadInfo {
  namespace: string;
  name: string;
  /** Image tag of the first container, when one can be read. */
  version?: string;
  readyReplicas: number;
}

/**
 * Read-only cluster questions detection is allowed to ask.
 *
 * Implemented by a fake in tests and by the Kubernetes client in Plan 4, so
 * every integration's detection is testable without a cluster.
 *
 * A denial surfaces as a thrown `ProbeDeniedError` rather than `false`; the
 * difference between "absent" and "not allowed to look" is the whole point.
 */
export interface ClusterProbes {
  hasCrd(name: string): Promise<boolean>;
  workload(
    kind: 'Deployment' | 'DaemonSet' | 'StatefulSet',
    namespace: string,
    name: string,
  ): Promise<WorkloadInfo | null>;
  service(namespace: string, name: string): Promise<boolean>;
  /** Endpoints with at least one ready address. */
  serviceHasReadyEndpoints(namespace: string, name: string): Promise<boolean>;
  ingressClass(name: string): Promise<boolean>;
  storageClassProvisioners(): Promise<readonly string[]>;
}

export class ProbeDeniedError extends Error {
  constructor(what: string) {
    super(`Not permitted to read ${what}`);
    this.name = 'ProbeDeniedError';
  }
}

export interface DetectContext {
  probes: ClusterProbes;
}

/** Rows an emitting collector produces, already shaped for the facet. */
export interface Emission {
  facet: FacetId;
  rows: readonly Record<string, unknown>[];
}

export interface CollectorContext {
  probes: ClusterProbes;
  now(): number;
}

export type Collector =
  | {
      kind: 'poll';
      id: string;
      intervalMs: number;
      run(ctx: CollectorContext): Promise<Emission[]>;
    }
  | { kind: 'stream'; id: string; start(ctx: CollectorContext, sink: Sink): Promise<Stoppable> }
  /** Rows arrive over the ingest API rather than being pulled. */
  | { kind: 'push'; id: string; facet: FacetId };

export type Sink = (emission: Emission) => Promise<void>;

export interface Stoppable {
  stop(): Promise<void>;
}

export interface IntegrationModule {
  readonly id: string;
  readonly title: string;
  readonly scope: IntegrationScope;
  /** Facets this module may emit. The conformance suite holds it to this. */
  readonly facets: readonly FacetId[];
  readonly requiredRbac: readonly RbacRule[];
  detect(ctx: DetectContext): Promise<Detection>;
  collectors(): readonly Collector[];
  /** Vendor detail pages this integration unlocks when present. */
  readonly nav?: readonly NavEntry[];
  /** Extra tables, which must be named `x_<id>_*` and carry retention. */
  readonly tables?: readonly string[];
}

export type { IntegrationState };
