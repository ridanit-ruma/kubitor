import { describe, expect, it } from 'vitest';
import type { IntegrationModule } from './contract.js';
import { IntegrationRegistry } from './registry.js';

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

describe('IntegrationRegistry', () => {
  it('looks a module up by id', () => {
    const registry = new IntegrationRegistry([module({ id: 'traefik' })]);

    expect(registry.byId('traefik')?.title).toBe('traefik');
    expect(registry.byId('nope')).toBeUndefined();
    expect(registry.all()).toHaveLength(1);
  });

  it('lists which integrations could feed a facet', () => {
    const registry = new IntegrationRegistry([
      module({ id: 'traefik' }),
      module({ id: 'nginx' }),
      module({ id: 'rook', facets: ['storage.volumes'] }),
    ]);

    expect(registry.sourcesOf('http.access')).toEqual(['traefik', 'nginx']);
    expect(registry.sourcesOf('network.flows')).toEqual([]);
  });

  /* Validation runs at construction so a bad module fails at startup, loudly. */

  it('refuses a duplicate id', () => {
    expect(() => new IntegrationRegistry([module({ id: 'a' }), module({ id: 'a' })])).toThrow(
      /Duplicate integration id/,
    );
  });

  it('refuses an id that is not kebab-case', () => {
    for (const id of ['Traefik', 'ingress_nginx', '1st', '-x']) {
      expect(() => new IntegrationRegistry([module({ id })]), id).toThrow(/kebab-case/);
    }
  });

  it('refuses a facet that is not part of the shared vocabulary', () => {
    expect(
      () => new IntegrationRegistry([module({ id: 'x', facets: ['http.acess' as never] })]),
    ).toThrow(/unknown facet/);
  });

  it('refuses an extra table that is not namespaced to the integration', () => {
    expect(() => new IntegrationRegistry([module({ id: 'cilium', tables: ['flows'] })])).toThrow(
      /must be prefixed x_cilium_/,
    );

    expect(
      () => new IntegrationRegistry([module({ id: 'cilium', tables: ['x_cilium_flows'] })]),
    ).not.toThrow();
  });
});
