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

describe('the Hardware screen reaches the sidebar', () => {
  function manifestFor(reporting: string[], expected: number) {
    const module = integration(reporting, expected);

    return buildManifest({
      registry: new IntegrationRegistry([module]),
      states: [
        {
          id: 'host-agent',
          state: reporting.length > 0 ? 'present' : 'absent',
          evidence: 'test',
          override: 'auto',
          degraded: [],
          checkedAt: 0,
        },
      ],
      agent: { installed: reporting.length > 0, reporting: reporting.length, expected, stale: [] },
      cluster: { version: 'v1.36.3', nodes: expected },
      coreNav: [],
      generatedAt: 0,
    });
  }

  /**
   * The regression this whole module exists to prevent.
   *
   * A facet appears on screen only when a `present` integration declares it.
   * The agents can be reporting on every node, the rows can be in the database,
   * and the screen still stays hidden if nothing claims the facet — which is
   * exactly what shipped the first time.
   */
  it('offers Hardware once the agent is reporting', () => {
    const manifest = manifestFor(['calder'], 1);

    expect(manifest.facets['host.resources']?.enabled).toBe(true);
    expect(manifest.nav.map((entry) => entry.href)).toContain('/hardware');
  });

  it('hides Hardware when no agent has reported', () => {
    const manifest = manifestFor([], 4);

    expect(manifest.facets['host.resources']?.enabled).toBe(false);
    expect(manifest.nav.map((entry) => entry.href)).not.toContain('/hardware');
  });
});
