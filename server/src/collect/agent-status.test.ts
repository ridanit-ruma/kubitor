import { describe, expect, it } from 'vitest';
import { agentStatus } from './agent-status.js';

describe('agentStatus', () => {
  it('counts only cluster nodes towards coverage', () => {
    const status = agentStatus({
      reporting: ['ken', 'calder', 'buildbox'],
      nodes: ['ken', 'calder', 'usher'],
      credentialed: ['buildbox'],
    });

    expect(status.reporting).toBe(2);
    expect(status.expected).toBe(3);
    expect(status.standalone).toBe(1);
  });

  /**
   * The bug this function exists for: a standalone host reporting used to make
   * up the numbers for a node whose agent had stopped.
   */
  it('still reports a silent node when a standalone host is reporting', () => {
    const status = agentStatus({
      reporting: ['ken', 'calder', 'buildbox'],
      nodes: ['ken', 'calder', 'usher'],
      credentialed: [],
    });

    expect(status.reporting).toBeLessThan(status.expected);
    expect(status.stale).toEqual(['usher']);
  });

  /**
   * A node with no agent anywhere is not stale — nothing was ever expected of
   * it. Once one node reports, the DaemonSet is clearly deployed and a node
   * missing from it is a real gap.
   */
  it('calls no node stale until at least one node reports', () => {
    expect(
      agentStatus({ reporting: [], nodes: ['ken', 'calder'], credentialed: [] }).stale,
    ).toEqual([]);
  });

  /** A static token is an explicit expectation, whatever the nodes are doing. */
  it('calls a credentialed host stale as soon as it stops reporting', () => {
    const status = agentStatus({ reporting: [], nodes: [], credentialed: ['buildbox'] });

    expect(status.stale).toEqual(['buildbox']);
    expect(status.installed).toBe(false);
  });

  it('names a machine once even when it is both a node and credentialed', () => {
    const status = agentStatus({
      reporting: ['ken'],
      nodes: ['ken', 'usher'],
      credentialed: ['usher'],
    });

    expect(status.stale).toEqual(['usher']);
  });

  it('reports installed as soon as anything reports', () => {
    expect(agentStatus({ reporting: ['buildbox'], nodes: [], credentialed: [] }).installed).toBe(
      true,
    );
  });

  /** Without Kubernetes access there are no nodes, so there is no coverage claim. */
  it('claims no coverage when kubitor cannot see the cluster', () => {
    const status = agentStatus({ reporting: ['buildbox'], nodes: [], credentialed: [] });

    expect(status.expected).toBe(0);
    expect(status.reporting).toBe(0);
    expect(status.standalone).toBe(1);
  });
});
