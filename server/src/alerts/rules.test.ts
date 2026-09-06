import { describe, expect, it } from 'vitest';
import type { World } from './rule.js';
import { CORE_RULES, RULES_BY_ID } from './rules.js';

const NOW = 1_756_800_000_000;

function world(overrides: Partial<World> = {}): World {
  return { nodes: [], pods: [], staleAgents: [], lastBackup: null, now: NOW, ...overrides };
}

function pod(overrides: Partial<World['pods'][number]> = {}): World['pods'][number] {
  return {
    namespace: 'default',
    name: 'web-0',
    phase: 'Running',
    reason: null,
    ready: 1,
    restarts: 0,
    ...overrides,
  };
}

const rule = (id: string) => {
  const found = RULES_BY_ID.get(id);
  if (!found) throw new Error(`no rule ${id}`);
  return found;
};

describe('every rule', () => {
  /**
   * A rule that cannot express what better looks like is not ready to be a
   * rule: the channel would only ever report bad news, and people would stop
   * reading it because they could not tell an outage from its aftermath.
   */
  it('reports nothing about a healthy cluster, so recovery is expressible', () => {
    for (const each of CORE_RULES) {
      expect(each.observe(world()), each.id).toEqual([]);
    }
  });

  it('names a subject for every observation, because that is half the identity', () => {
    const busy = world({
      nodes: [{ name: 'ken', ready: 0 }],
      pods: [
        pod({ reason: 'CrashLoopBackOff' }),
        pod({ name: 'web-1', reason: 'Unschedulable' }),
        pod({ name: 'web-2', reason: 'ImagePullBackOff' }),
      ],
      staleAgents: ['buildbox'],
      lastBackup: { ok: false, error: 'AccessDenied', startedAt: NOW },
    });

    for (const each of CORE_RULES) {
      for (const observation of each.observe(busy)) {
        expect(observation.subject, each.id).toBeTruthy();
        expect(observation.summary, each.id).toBeTruthy();
      }
    }
  });

  it('damps at least one evaluation everywhere', () => {
    for (const each of CORE_RULES) {
      expect(each.fireAfter, each.id).toBeGreaterThanOrEqual(1);
      expect(each.resolveAfter, each.id).toBeGreaterThanOrEqual(1);
    }
  });
});

describe('node-not-ready', () => {
  it('names the node that is not ready', () => {
    const observations = rule('node-not-ready').observe(
      world({
        nodes: [
          { name: 'ken', ready: 0 },
          { name: 'calder', ready: 1 },
        ],
      }),
    );

    expect(observations.map((o) => o.subject)).toEqual(['ken']);
  });

  /** A kubelet restart shows not-ready briefly and recovers on its own. */
  it("waits for a second evaluation before it is anybody's problem", () => {
    expect(rule('node-not-ready').fireAfter).toBeGreaterThan(1);
  });
});

describe('pod-crashloop', () => {
  it('names the namespaced pod and how often it has restarted', () => {
    const [observation] = rule('pod-crashloop').observe(
      world({
        pods: [
          pod({
            namespace: 'kubitor',
            name: 'server-7d9',
            reason: 'CrashLoopBackOff',
            restarts: 12,
          }),
        ],
      }),
    );

    expect(observation?.subject).toBe('kubitor/server-7d9');
    expect(observation?.detail).toContain('12');
  });

  /**
   * Every rollout passes through these. A rule that fired on them would page
   * somebody on every deploy.
   */
  it('ignores the states every rollout passes through', () => {
    const rolling = world({
      pods: [pod({ reason: 'ContainerCreating' }), pod({ name: 'b', reason: 'PodInitializing' })],
    });

    for (const each of CORE_RULES) {
      expect(each.observe(rolling), each.id).toEqual([]);
    }
  });
});

describe('pod-image-pull', () => {
  it('catches the several names Kubernetes gives one problem', () => {
    for (const reason of ['ImagePullBackOff', 'ErrImagePull', 'InvalidImageName']) {
      const observations = rule('pod-image-pull').observe(world({ pods: [pod({ reason })] }));
      expect(observations, reason).toHaveLength(1);
    }
  });

  it('leaves a crash-looping pod to its own rule', () => {
    expect(
      rule('pod-image-pull').observe(world({ pods: [pod({ reason: 'CrashLoopBackOff' })] })),
    ).toEqual([]);
  });
});

describe('agent-silent', () => {
  it('says the cluster view is unaffected, because it is', () => {
    const [observation] = rule('agent-silent').observe(world({ staleAgents: ['buildbox'] }));

    expect(observation?.subject).toBe('buildbox');
    expect(observation?.detail).toContain('cluster view is unaffected');
  });
});

describe('backup-failed', () => {
  it('carries the reason the bucket gave', () => {
    const [observation] = rule('backup-failed').observe(
      world({ lastBackup: { ok: false, error: 'S3 answered 403: AccessDenied', startedAt: NOW } }),
    );

    expect(observation?.detail).toContain('AccessDenied');
  });

  it('says nothing when the last backup worked', () => {
    expect(
      rule('backup-failed').observe(
        world({ lastBackup: { ok: true, error: null, startedAt: NOW } }),
      ),
    ).toEqual([]);
  });

  it('says nothing when backups are not configured at all', () => {
    expect(rule('backup-failed').observe(world({ lastBackup: null }))).toEqual([]);
  });

  /**
   * A backup runs on a schedule, not a loop. Waiting for a second failure
   * means waiting a day to be told about the first.
   */
  it('fires on the first failure', () => {
    expect(rule('backup-failed').fireAfter).toBe(1);
  });
});
