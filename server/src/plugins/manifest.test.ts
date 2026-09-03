import type { NavEntry } from '@kubitor/shared';
import { describe, expect, it } from 'vitest';
import type { StoredIntegrationState } from '../db/integration-state.repo.js';
import type { IntegrationModule } from './contract.js';
import { buildManifest } from './manifest.js';
import { IntegrationRegistry } from './registry.js';

const NOW = 1_756_800_000_000;

function module(overrides: Partial<IntegrationModule> & { id: string }): IntegrationModule {
  return {
    title: overrides.id,
    scope: 'cluster',
    facets: ['http.access'],
    requiredRbac: [],
    detect: async () => ({ state: 'absent', evidence: 'stub' }),
    collectors: () => [],
    ...overrides,
  };
}

function state(
  overrides: Partial<StoredIntegrationState> & { id: string },
): StoredIntegrationState {
  return {
    state: 'present',
    version: null,
    evidence: 'stub',
    unknownReason: null,
    override: 'auto',
    degraded: [],
    checkedAt: NOW,
    ...overrides,
  };
}

function build(
  modules: IntegrationModule[],
  states: StoredIntegrationState[],
  coreNav: NavEntry[] = [],
) {
  return buildManifest({
    registry: new IntegrationRegistry(modules),
    states,
    agent: { installed: false, reporting: 0, expected: 4, stale: [] },
    kubitor: { version: 'test' },
    cluster: { version: 'v1.36.3', nodes: 4 },
    coreNav,
    generatedAt: NOW,
  });
}

describe('buildManifest', () => {
  it('enables a facet that a present integration feeds', () => {
    const manifest = build([module({ id: 'traefik' })], [state({ id: 'traefik' })]);

    expect(manifest.facets['http.access']).toEqual({ enabled: true, sources: ['traefik'] });
  });

  it('disables a facet whose only source is absent', () => {
    const manifest = build(
      [module({ id: 'traefik' })],
      [state({ id: 'traefik', state: 'absent' })],
    );

    expect(manifest.facets['http.access']?.enabled).toBe(false);
    expect(manifest.facets['http.access']?.sources).toEqual([]);
  });

  /**
   * Installed but unable to deliver. The screen stays hidden and the reason is
   * reported, rather than showing an empty graph with no explanation.
   */
  it('disables a facet whose only source is degraded, and says who degraded it', () => {
    const manifest = build(
      [module({ id: 'cilium', facets: ['network.flows'] })],
      [
        state({
          id: 'cilium',
          degraded: [{ facet: 'network.flows', reason: 'hubble-relay has no ready endpoints' }],
        }),
      ],
    );

    expect(manifest.facets['network.flows']).toEqual({
      enabled: false,
      sources: [],
      degradedBy: ['cilium'],
    });
  });

  it('enables a facet when a second source is healthy', () => {
    const manifest = build(
      [module({ id: 'cilium' }), module({ id: 'traefik' })],
      [
        state({ id: 'cilium', degraded: [{ facet: 'http.access', reason: 'relay down' }] }),
        state({ id: 'traefik' }),
      ],
    );

    expect(manifest.facets['http.access']?.enabled).toBe(true);
    expect(manifest.facets['http.access']?.sources).toEqual(['traefik']);
  });

  it('lets a user override turn an integration off', () => {
    const manifest = build(
      [module({ id: 'traefik' })],
      [state({ id: 'traefik', override: 'force_off' })],
    );

    expect(manifest.integrations[0]?.state).toBe('absent');
    expect(manifest.facets['http.access']?.enabled).toBe(false);
  });

  it('lets a user override turn an integration on', () => {
    const manifest = build(
      [module({ id: 'traefik' })],
      [state({ id: 'traefik', state: 'absent', override: 'force_on' })],
    );

    expect(manifest.integrations[0]?.state).toBe('present');
    expect(manifest.facets['http.access']?.enabled).toBe(true);
  });

  it('reports an integration that has never been probed as unknown', () => {
    const manifest = build([module({ id: 'traefik' })], []);

    expect(manifest.integrations[0]?.state).toBe('unknown');
    expect(manifest.integrations[0]?.evidence).toBe('Not probed yet');
  });

  it('carries the reason a state is unknown', () => {
    const manifest = build(
      [module({ id: 'cilium' })],
      [state({ id: 'cilium', state: 'unknown', unknownReason: 'rbac' })],
    );

    expect(manifest.integrations[0]?.unknownReason).toBe('rbac');
  });

  describe('navigation', () => {
    const flows: NavEntry = {
      id: 'flows',
      title: 'Flows',
      category: 'network',
      href: '/integrations/cilium/flows',
      requiresFacet: 'network.flows',
    };

    it('includes a vendor page once its facet is available', () => {
      const manifest = build(
        [module({ id: 'cilium', facets: ['network.flows'], nav: [flows] })],
        [state({ id: 'cilium' })],
      );

      expect(manifest.nav.map((entry) => entry.id)).toContain('flows');
    });

    it('omits a vendor page whose facet is unavailable', () => {
      const manifest = build(
        [module({ id: 'cilium', facets: ['network.flows'], nav: [flows] })],
        [state({ id: 'cilium', state: 'absent' })],
      );

      expect(manifest.nav.map((entry) => entry.id)).not.toContain('flows');
    });

    it('keeps core navigation that depends on no facet', () => {
      const core: NavEntry = {
        id: 'nodes',
        title: 'Nodes',
        category: 'infrastructure',
        href: '/nodes',
      };

      const manifest = build([], [], [core]);

      expect(manifest.nav).toEqual([core]);
    });

    it('orders entries by category so the sidebar is stable', () => {
      const entries: NavEntry[] = [
        { id: 'settings', title: 'Settings', category: 'settings', href: '/settings' },
        { id: 'overview', title: 'Overview', category: 'overview', href: '/' },
        { id: 'nodes', title: 'Nodes', category: 'infrastructure', href: '/nodes' },
      ];

      const manifest = build([], [], entries);

      expect(manifest.nav.map((entry) => entry.id)).toEqual(['overview', 'nodes', 'settings']);
    });
  });
});
