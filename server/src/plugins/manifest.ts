import type {
  AgentStatus,
  CapabilityManifest,
  FacetAvailability,
  FacetId,
  IntegrationStatus,
  NavEntry,
} from '@kubitor/shared';
import type { StoredIntegrationState } from '../db/integration-state.repo.js';
import { effectiveState } from './detection.service.js';
import type { IntegrationRegistry } from './registry.js';

export interface ManifestInput {
  registry: IntegrationRegistry;
  states: readonly StoredIntegrationState[];
  agent: AgentStatus;
  kubitor: { version: string };
  cluster: { version: string; nodes: number };
  /** Navigation the core always provides, before integrations add to it. */
  coreNav: readonly NavEntry[];
  generatedAt: number;
}

/**
 * Pure: statuses and module metadata in, the client's whole navigation out.
 *
 * The client compiles every integration's UI but mounts only what appears here,
 * which is what lets one build serve a bare k3s cluster and a full stack.
 */
export function buildManifest(input: ManifestInput): CapabilityManifest {
  const byId = new Map(input.states.map((state) => [state.id, state]));

  const integrations: IntegrationStatus[] = input.registry.all().map((module) => {
    const stored = byId.get(module.id);
    const detected = stored?.state ?? 'unknown';
    const override = stored?.override ?? 'auto';

    const status: IntegrationStatus = {
      id: module.id,
      title: module.title,
      scope: module.scope,
      state: effectiveState(detected, override),
      evidence: stored?.evidence ?? 'Not probed yet',
      override,
      facets: [...module.facets],
      degraded: stored?.degraded ?? [],
    };

    if (stored?.version) status.version = stored.version;
    if (status.state === 'unknown' && stored?.unknownReason) {
      status.unknownReason = stored.unknownReason;
    }

    return status;
  });

  const facets = availability(integrations);

  const nav = [...input.coreNav, ...navFromIntegrations(input.registry, integrations)].filter(
    (entry) => !entry.requiresFacet || facets[entry.requiresFacet]?.enabled === true,
  );

  return {
    generatedAt: input.generatedAt,
    kubitor: input.kubitor,
    cluster: input.cluster,
    agent: input.agent,
    integrations,
    facets,
    nav: [...nav].sort(byCategoryThenOrder),
  };
}

function availability(
  integrations: readonly IntegrationStatus[],
): Partial<Record<FacetId, FacetAvailability>> {
  const result: Partial<Record<FacetId, FacetAvailability>> = {};

  for (const integration of integrations) {
    for (const facet of integration.facets) {
      const entry: FacetAvailability = result[facet] ?? { enabled: false, sources: [] };

      const degradedHere = integration.degraded.some((reason) => reason.facet === facet);

      if (integration.state === 'present' && !degradedHere) {
        entry.enabled = true;
        entry.sources.push(integration.id);
      } else if (integration.state === 'present' && degradedHere) {
        // Installed but unable to deliver this facet right now. The screen stays
        // hidden, and the reason is reported rather than shown as an empty page.
        entry.degradedBy = [...(entry.degradedBy ?? []), integration.id];
      }

      result[facet] = entry;
    }
  }

  return result;
}

function navFromIntegrations(
  registry: IntegrationRegistry,
  integrations: readonly IntegrationStatus[],
): NavEntry[] {
  const present = new Set(
    integrations.filter((integration) => integration.state === 'present').map((i) => i.id),
  );

  return registry
    .all()
    .filter((module) => present.has(module.id))
    .flatMap((module) => [...(module.nav ?? [])]);
}

const CATEGORY_ORDER = [
  'overview',
  'infrastructure',
  'network',
  'storage',
  'delivery',
  'hosts',
  'security',
  'settings',
] as const;

function byCategoryThenOrder(a: NavEntry, b: NavEntry): number {
  const category = CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category);
  if (category !== 0) return category;
  return (a.order ?? 0) - (b.order ?? 0);
}
