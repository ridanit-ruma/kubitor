import { describe, expect, it } from 'vitest';
import { buildManifest } from '../../plugins/manifest.js';
import { IntegrationRegistry } from '../../plugins/registry.js';
import { fakeProbes } from '../../test/fake-probes.js';
import { hostAgentIntegration } from './index.js';

function integration(reporting: string[], expected: number) {
  return hostAgentIntegration({ reporting: () => reporting, expected: () => expected });
}

describe('hostAgentIntegration detection', () => {
  const probes = fakeProbes({});

  it('is absent until a node has actually reported', async () => {
    const detected = await integration([], 4).detect({ probes });

    expect(detected.state).toBe('absent');
    expect(detected.evidence).toContain('No agent');
  });

  it('is present once every node reports, and says so', async () => {
    const detected = await integration(['calder', 'decker', 'ken', 'usher'], 4).detect({ probes });

    expect(detected.state).toBe('present');
    expect(detected.evidence).toBe('4 of 4 nodes reporting');
  });

  /**
   * Installed everywhere is not the same as installed. A DaemonSet that cannot
   * reach the server on two nodes leaves those machines unmeasured, and a
   * silently short list is how that goes unnoticed.
   */
  it('reports partial coverage as degraded rather than as working', async () => {
    const detected = await integration(['calder', 'decker'], 4).detect({ probes });

    expect(detected.state).toBe('present');
    expect(detected).toHaveProperty('degraded');
    expect(detected.evidence).toBe('2 of 4 nodes reporting');
  });
});

describe('the agent enables the facets its screens read', () => {
  function manifestFor(reporting: string[], expected: number) {
    const module = integration(reporting, expected);

    return buildManifest({
      registry: new IntegrationRegistry([module]),
      states: [
        {
          id: 'host-agent',
          state: reporting.length > 0 ? 'present' : 'absent',
          version: null,
          evidence: 'test',
          unknownReason: null,
          override: 'auto',
          degraded: [],
          checkedAt: 0,
        },
      ],
      agent: { installed: reporting.length > 0, reporting: reporting.length, expected, stale: [] },
      kubitor: { version: 'test' },
      cluster: { version: 'v1.36.3', nodes: expected },
      coreNav: [],
      generatedAt: 0,
    });
  }

  /**
   * The regression this module exists to prevent.
   *
   * A facet is available only when a `present` integration declares it. The
   * agents can be reporting on every node and the rows can be in the database,
   * and the screens that read those rows still stay empty if nothing claims the
   * facet — which is exactly what shipped the first time.
   */
  it('makes host facets available once the agent is reporting', () => {
    const manifest = manifestFor(['calder'], 1);

    expect(manifest.facets['host.resources']?.enabled).toBe(true);
    expect(manifest.facets['host.hardware']?.enabled).toBe(true);
    expect(manifest.facets['host.resources']?.sources).toContain('host-agent');
  });

  it('leaves them unavailable when no agent has reported', () => {
    const manifest = manifestFor([], 4);

    expect(manifest.facets['host.resources']?.enabled).toBe(false);
    expect(manifest.facets['host.hardware']?.enabled).toBe(false);
  });

  /**
   * Host facts describe a node, so they appear on that node's screens. A
   * separate entry made the reader hold two pages in their head to answer one
   * question about one machine.
   */
  it('adds no navigation of its own', () => {
    expect(manifestFor(['calder'], 1).nav).toEqual([]);
  });
});
