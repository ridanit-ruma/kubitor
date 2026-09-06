import type { AgentStatus } from '@kubitor/shared';

export interface AgentStatusInput {
  /** Every machine that has reported recently, nodes and standalone alike. */
  reporting: readonly string[];
  /** Cluster node names; empty where kubitor has no Kubernetes access. */
  nodes: readonly string[];
  /** Names holding a static agent token, which is an explicit expectation. */
  credentialed: readonly string[];
}

/**
 * What the dashboard says about agent coverage.
 *
 * Coverage is a statement about nodes, so a standalone host must never make up
 * the numbers for a node whose agent has stopped — which is exactly what
 * counting every reporting machine as a node used to do.
 */
export function agentStatus(input: AgentStatusInput): AgentStatus {
  const reporting = new Set(input.reporting);
  const nodes = new Set(input.nodes);

  const reportingNodes = input.nodes.filter((node) => reporting.has(node));
  const standalone = input.reporting.filter((host) => !nodes.has(host));

  // A node is only expected to report once something proves an agent is
  // deployed at all. Otherwise a cluster that never installed the agent would
  // report every one of its nodes as having gone quiet.
  const expectedNodes = reportingNodes.length > 0 ? input.nodes : [];
  const stale = [...new Set([...expectedNodes, ...input.credentialed])]
    .filter((name) => !reporting.has(name))
    .sort();

  return {
    // "Installed" means something has actually reported, not that a manifest
    // exists: a DaemonSet that cannot reach the server is not installed from
    // the dashboard's point of view.
    installed: input.reporting.length > 0,
    reporting: reportingNodes.length,
    expected: input.nodes.length,
    standalone: standalone.length,
    stale,
  };
}
