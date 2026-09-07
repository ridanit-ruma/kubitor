import type { DegradedReason } from '@kubitor/shared';
import type { Collector, IntegrationModule } from '../../plugins/contract.js';

export interface HostAgentDeps {
  /** Nodes whose agent has reported recently. */
  reporting(): readonly string[];
  /** Nodes the cluster has, so partial coverage is visible rather than implied. */
  expected(): number;
  /**
   * Whether any machine is reporting who is logged into it.
   *
   * Session collection is off in every agent until somebody turns it on, so
   * the facet is present only where somebody has. An empty Sessions screen
   * offering to watch colleagues is not a good default.
   */
  sessionsSeen?(): Promise<{ sessions: boolean; access: boolean }>;
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
    facets: ['host.hardware', 'host.resources', 'host.sessions', 'host.access'],
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

      // Off in every agent by default, so absent is the normal answer and not
      // a fault. The reason says which switch turns it on.
      const seen = (await deps.sessionsSeen?.()) ?? { sessions: false, access: false };
      const quiet: DegradedReason[] = [];
      if (!seen.sessions) {
        quiet.push({
          facet: 'host.sessions',
          reason: 'No agent is reporting sessions. Set KUBITOR_AGENT_SESSIONS on a machine.',
        });
      }
      if (!seen.access) {
        quiet.push({
          facet: 'host.access',
          reason:
            'No agent is reporting login attempts. They are read from an auth log, which needs KUBITOR_AGENT_AUTH_LOG.',
        });
      }

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
            ...quiet,
          ],
        };
      }

      return quiet.length > 0
        ? { state: 'present', evidence, degraded: quiet }
        : { state: 'present', evidence };
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
