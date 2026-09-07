import type { CapabilityManifest, IntegrationOverride, NavEntry } from '@kubitor/shared';
import { type Capability, can } from '../auth/roles.js';
import type { IntegrationStateRepo } from '../db/integration-state.repo.js';
import type { DetectionService } from './detection.service.js';
import { buildManifest } from './manifest.js';
import type { IntegrationRegistry } from './registry.js';

/** Screens the core always provides, whatever the cluster runs. */
export const CORE_NAV: readonly NavEntry[] = [
  { id: 'overview', title: 'Overview', category: 'overview', href: '/', order: 0 },
  {
    id: 'nodes',
    title: 'Nodes',
    category: 'infrastructure',
    href: '/nodes',
    // A node's own page is a machine page, and machine pages live under
    // `/hosts`. Where there is no Hosts screen, this entry is where the reader
    // came from and where Back goes.
    alsoMatches: '/hosts',
    order: 0,
  },
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
  // The first thing in the `security` category, which the manifest has always
  // had a slot for and nothing to put in it.
  { id: 'alerts', title: 'Alerts', category: 'security', href: '/alerts', order: 0 },
  {
    id: 'sessions',
    title: 'Sessions',
    category: 'security',
    href: '/sessions',
    // Absent unless an agent is configured to report them, which is off by
    // default: this is a feature people are subject to, and an empty screen
    // offering to watch colleagues is not a good default.
    requiresFacet: 'host.sessions',
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
  {
    id: 'agents',
    title: 'Agents',
    category: 'settings',
    href: '/settings/agents',
    order: 2,
  },
  {
    id: 'backups',
    title: 'Backups',
    category: 'settings',
    href: '/settings/backups',
    order: 3,
  },
];

/**
 * What a screen needs before it is worth offering.
 *
 * Kept beside the navigation rather than inside it so the shared `NavEntry`
 * type stays about screens, and so this list is the one place to read when
 * asking which roles see what. Screens absent from it are cluster screens,
 * which every role may see.
 */
const NAV_REQUIRES: Record<string, Capability> = {
  integrations: 'integrations.write',
  accounts: 'accounts.manage',
  agents: 'agents.manage',
  backups: 'backups.manage',
};

/**
 * The Hosts screen, mounted only where a machine is not a cluster node.
 *
 * With agents on nodes alone it would list exactly what Nodes lists, and a
 * second screen answering the same question is what the capability manifest
 * exists to prevent. One machine outside the cluster makes it a different
 * question, and only then does the entry appear.
 */
export const HOSTS_NAV: NavEntry = {
  id: 'hosts',
  title: 'Hosts',
  category: 'hosts',
  href: '/hosts',
  order: 0,
};

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

  /**
   * The manifest as one role sees it.
   *
   * Filtering here gives per-role navigation with no client change, because the
   * client already builds its menu from what this returns. It is a courtesy,
   * not a control: every route the hidden screens call checks the capability
   * again for itself.
   */
  async manifest(now: number, role?: string): Promise<CapabilityManifest> {
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
      coreNav: visibleTo(agent.standalone > 0 ? [...CORE_NAV, HOSTS_NAV] : CORE_NAV, role),
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

/** The entries a role may open; everything else is left out of its menu. */
function visibleTo(entries: readonly NavEntry[], role: string | undefined): NavEntry[] {
  if (role === undefined) return [...entries];

  return entries.filter((entry) => {
    const required = NAV_REQUIRES[entry.id];
    return required === undefined || can(role, required);
  });
}
