import type { Collector, IntegrationModule } from '../../plugins/contract.js';

export interface HostAgentDeps {
  /** Nodes whose agent has reported recently. */
  reporting(): readonly string[];
  /** Nodes the cluster has, so partial coverage is visible rather than implied. */
  expected(): number;
}

/**
 * The agent, as a capability rather than a collector.
 *
 * It has no collectors: the agents push, and the server never polls them. What
 * this module exists for is the manifest. A facet appears on screen only when a
 * `present` integration declares it, so without this the agents could be
 * reporting on every node and the Hardware screen would still be hidden —
 * which is exactly what happened the first time the screen shipped.
 *
 * Detection is by evidence, not by manifest: a DaemonSet that exists but cannot
 * reach the server is not installed from a reader's point of view.
 */
export function hostAgentIntegration(deps: HostAgentDeps): IntegrationModule {
  return {
    id: 'host-agent',
    title: 'Host agent',
    scope: 'node',
    facets: ['host.hardware', 'host.resources'],
    // The agent reads the host, not the API server. Nothing to grant.
    requiredRbac: [],

    async detect() {
      const reporting = deps.reporting();
      const expected = deps.expected();

      if (reporting.length === 0) {
        return {
          state: 'absent',
          evidence: 'No agent has reported host metrics',
        };
      }

      const evidence = `${reporting.length} of ${expected} nodes reporting`;

      // Installed, but not everywhere. The screens still work; they are just
      // blind on some machines, and saying so beats a silently short list.
      if (expected > reporting.length) {
        return {
          state: 'present',
          evidence,
          degraded: [
            {
              facet: 'host.resources',
              reason: `No agent on ${missing(reporting, expected)}`,
            },
          ],
        };
      }

      return { state: 'present', evidence };
    },

    collectors(): readonly Collector[] {
      return [];
    },

    /*
     * No navigation of its own.
     *
     * Host facts belong to the node they describe, so they appear on the node's
     * own screens. A separate Hardware entry made the reader hold two pages in
     * their head to answer one question about one machine.
     */
  };
}

function missing(reporting: readonly string[], expected: number): string {
  const count = expected - reporting.length;
  return `${count} node${count === 1 ? '' : 's'}`;
}
