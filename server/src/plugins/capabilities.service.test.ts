import type { AgentStatus } from '@kubitor/shared';
import { describe, expect, it } from 'vitest';
import type { IntegrationStateRepo } from '../db/integration-state.repo.js';
import { CapabilitiesService } from './capabilities.service.js';
import type { DetectionService } from './detection.service.js';
import { IntegrationRegistry } from './registry.js';

const NOW = 1_756_800_000_000;

function serviceWith(agent: AgentStatus): CapabilitiesService {
  return new CapabilitiesService({
    version: 'test',
    registry: new IntegrationRegistry([]),
    states: { list: async () => [] } as unknown as IntegrationStateRepo,
    detection: {} as DetectionService,
    clusterFacts: async () => ({ version: 'v1.36.3', nodes: 4 }),
    agentStatus: async () => agent,
  });
}

const covered: AgentStatus = {
  installed: true,
  reporting: 4,
  expected: 4,
  standalone: 0,
  stale: [],
};

describe('the Hosts screen', () => {
  it('is absent while every reporting machine is a node', async () => {
    const manifest = await serviceWith(covered).manifest(NOW);

    expect(manifest.nav.map((entry) => entry.id)).not.toContain('hosts');
  });

  /**
   * With agents on nodes alone, a Hosts screen answers the same question as
   * Nodes, and two screens answering one question is what this architecture
   * exists to avoid. A machine outside the cluster is what makes it a
   * different question.
   */
  it('appears once a machine outside the cluster reports', async () => {
    const manifest = await serviceWith({ ...covered, standalone: 1 }).manifest(NOW);

    expect(manifest.nav.find((entry) => entry.id === 'hosts')).toMatchObject({
      category: 'hosts',
      href: '/hosts',
    });
  });
});

describe('core navigation', () => {
  it('offers the Agents panel, because a standalone host needs a credential', async () => {
    const manifest = await serviceWith(covered).manifest(NOW);

    expect(manifest.nav.find((entry) => entry.id === 'agents')).toMatchObject({
      category: 'settings',
      href: '/settings/agents',
    });
  });
});
