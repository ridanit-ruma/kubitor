import type { CapabilityManifest, IntegrationOverride, NavEntry } from '@kubitor/shared';
import type { IntegrationStateRepo } from '../db/integration-state.repo.js';
import type { DetectionService } from './detection.service.js';
import { buildManifest } from './manifest.js';
import type { IntegrationRegistry } from './registry.js';

/** Screens the core always provides, whatever the cluster runs. */
export const CORE_NAV: readonly NavEntry[] = [
  { id: 'overview', title: 'Overview', category: 'overview', href: '/', order: 0 },
  { id: 'nodes', title: 'Nodes', category: 'infrastructure', href: '/nodes', order: 0 },
  { id: 'workloads', title: 'Workloads', category: 'infrastructure', href: '/workloads', order: 1 },
  {
    id: 'namespaces',
    title: 'Namespaces',
    category: 'infrastructure',
    href: '/namespaces',
    order: 2,
  },
  { id: 'events', title: 'Events', category: 'infrastructure', href: '/events', order: 3 },
  {
    id: 'http-traffic',
    title: 'HTTP traffic',
    category: 'network',
    href: '/http',
    requiresFacet: 'http.access',
    order: 0,
  },
  {
    id: 'routes',
    title: 'Routes',
    category: 'network',
    href: '/routes',
    requiresFacet: 'http.routes',
    order: 1,
  },
  { id: 'integrations', title: 'Integrations', category: 'settings', href: '/settings', order: 0 },
  {
    id: 'accounts',
    title: 'Accounts',
    category: 'settings',
    href: '/settings/accounts',
    order: 1,
  },
];

export interface ClusterFacts {
  version: string;
  nodes: number;
}

export interface CapabilitiesDeps {
  /** The build this server is, reported so the client never shows the cluster's. */
  version: string;
  registry: IntegrationRegistry;
  states: IntegrationStateRepo;
  detection: DetectionService;
  /** Supplied by the Kubernetes collector once Plan 4 lands. */
  clusterFacts(): Promise<ClusterFacts>;
  agentStatus(): Promise<CapabilityManifest['agent']>;
}

export class CapabilitiesService {
  readonly #deps: CapabilitiesDeps;

  constructor(deps: CapabilitiesDeps) {
    this.#deps = deps;
  }

  async manifest(now: number): Promise<CapabilityManifest> {
    const [states, cluster, agent] = await Promise.all([
      this.#deps.states.list(),
      this.#deps.clusterFacts(),
      this.#deps.agentStatus(),
    ]);

    return buildManifest({
      registry: this.#deps.registry,
      states,
      agent,
      cluster,
      kubitor: { version: this.#deps.version },
      coreNav: CORE_NAV,
      generatedAt: now,
    });
  }

  async setOverride(id: string, override: IntegrationOverride): Promise<boolean> {
    return this.#deps.detection.setOverride(id, override);
  }

  /** Re-probes on demand, so a user who just installed something needn't wait. */
  async rescan(now: number): Promise<void> {
    await this.#deps.detection.runOnce(now);
  }
}
