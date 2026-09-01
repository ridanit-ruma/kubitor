import { describe, expect, it } from 'vitest';
import { FACET_IDS, FACET_KIND, type FacetId } from './facets.js';

describe('facet metadata', () => {
  it('classifies every declared facet', () => {
    for (const id of FACET_IDS) {
      expect(FACET_KIND[id], `facet ${id} has no kind`).toBeDefined();
    }
  });

  it('does not classify facets that are not declared', () => {
    const declared = new Set<string>(FACET_IDS);
    for (const id of Object.keys(FACET_KIND)) {
      expect(declared.has(id), `${id} is classified but not declared`).toBe(true);
    }
  });

  it('treats append-only facets as events and snapshots as state', () => {
    const expected: Partial<Record<FacetId, string>> = {
      'http.access': 'event',
      'http.routes': 'state',
      'host.hardware': 'event',
      workloads: 'state',
    };
    for (const [id, kind] of Object.entries(expected)) {
      expect(FACET_KIND[id as FacetId]).toBe(kind);
    }
  });
});
