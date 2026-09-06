import { beforeEach, expect, it } from 'vitest';
import { AlertsRepo } from '../db/alerts.repo.js';
import { migrateToLatest } from '../db/migrate.js';
import { describeEachDialect } from '../test/db-harness.js';
import { evaluate } from './evaluator.js';
import type { AlertRule, World } from './rule.js';

const NOW = 1_756_800_000_000;

function world(overrides: Partial<World> = {}): World {
  return {
    nodes: [],
    pods: [],
    staleAgents: [],
    lastBackup: null,
    now: NOW,
    ...overrides,
  };
}

/** A rule under the test's control, so damping can be exercised exactly. */
function ruleFiringOn(subjects: () => string[], damping: Partial<AlertRule> = {}): AlertRule {
  return {
    id: 'test-rule',
    title: 'Test',
    severity: 'warning',
    fireAfter: 2,
    resolveAfter: 2,
    observe: () => subjects().map((subject) => ({ subject, summary: `${subject} is wrong` })),
    ...damping,
  };
}

describeEachDialect('evaluate', (ctx) => {
  let repo: AlertsRepo;

  beforeEach(async () => {
    await migrateToLatest(ctx.db, ctx.kind);
    await ctx.db.deleteFrom('alerts').execute();
    repo = new AlertsRepo(ctx.db, ctx.sqlHelper);
  });

  /**
   * The point of damping. A pod that restarts once, or a node that blinks
   * while its kubelet restarts, must never reach a channel.
   */
  it('does not fire on the first evaluation when the rule asks for two', async () => {
    const rule = ruleFiringOn(() => ['a']);

    const first = await evaluate({ rules: [rule], world: world(), repo });

    expect(first).toEqual([]);
    expect(await repo.firing()).toEqual([]);
    const [pending] = await repo.openFor('test-rule');
    expect(pending).toMatchObject({ state: 'pending', seenCount: 1 });
  });

  it('fires once the condition has held long enough, and only once', async () => {
    const rule = ruleFiringOn(() => ['a']);

    await evaluate({ rules: [rule], world: world(), repo });
    const second = await evaluate({ rules: [rule], world: world({ now: NOW + 1000 }), repo });
    const third = await evaluate({ rules: [rule], world: world({ now: NOW + 2000 }), repo });

    expect(second.map((t) => t.kind)).toEqual(['fired']);
    expect(third).toEqual([]);
    expect(await repo.firing()).toHaveLength(1);
  });

  it('fires immediately when the rule asks for one evaluation', async () => {
    const rule = ruleFiringOn(() => ['a'], { fireAfter: 1 });

    const transitions = await evaluate({ rules: [rule], world: world(), repo });

    expect(transitions.map((t) => t.kind)).toEqual(['fired']);
  });

  /**
   * A channel that only ever reports bad news trains people to ignore it,
   * because they cannot tell an outage from its aftermath.
   */
  it('resolves what it fired', async () => {
    let subjects = ['a'];
    const rule = ruleFiringOn(() => subjects, { resolveAfter: 1 });

    await evaluate({ rules: [rule], world: world(), repo });
    await evaluate({ rules: [rule], world: world({ now: NOW + 1000 }), repo });

    subjects = [];
    const gone = await evaluate({ rules: [rule], world: world({ now: NOW + 2000 }), repo });

    expect(gone.map((t) => t.kind)).toEqual(['resolved']);
    expect(gone[0]?.alert.resolvedAt).toBe(NOW + 2000);
    expect(await repo.firing()).toEqual([]);
  });

  /** An alert that flickers off for one evaluation has flapped, not recovered. */
  it('does not resolve on a single absence when the rule asks for two', async () => {
    let subjects = ['a'];
    const rule = ruleFiringOn(() => subjects, { resolveAfter: 2 });

    await evaluate({ rules: [rule], world: world(), repo });
    await evaluate({ rules: [rule], world: world({ now: NOW + 1000 }), repo });

    subjects = [];
    const blip = await evaluate({ rules: [rule], world: world({ now: NOW + 2000 }), repo });
    expect(blip).toEqual([]);

    subjects = ['a'];
    const back = await evaluate({ rules: [rule], world: world({ now: NOW + 3000 }), repo });

    expect(back).toEqual([]);
    expect(await repo.firing()).toHaveLength(1);
  });

  /**
   * Telling somebody a problem is over when they were never told it started is
   * noise dressed as courtesy.
   */
  it('says nothing about a pending alert that went away before it fired', async () => {
    let subjects = ['a'];
    const rule = ruleFiringOn(() => subjects, { fireAfter: 3, resolveAfter: 1 });

    await evaluate({ rules: [rule], world: world(), repo });
    subjects = [];
    const transitions = await evaluate({ rules: [rule], world: world({ now: NOW + 1000 }), repo });

    expect(transitions).toEqual([]);
    expect(await repo.firing()).toEqual([]);
  });

  /** Identity is (rule, subject): two bad pods are two alerts, not one. */
  it('keeps one alert per subject', async () => {
    const rule = ruleFiringOn(() => ['a', 'b'], { fireAfter: 1 });

    const transitions = await evaluate({ rules: [rule], world: world(), repo });

    expect(transitions.map((t) => t.alert.subject).sort()).toEqual(['a', 'b']);
  });

  /** A recurrence is a new alert, so the history reads as a history. */
  it('opens a new alert when the same subject goes wrong again', async () => {
    let subjects = ['a'];
    const rule = ruleFiringOn(() => subjects, { fireAfter: 1, resolveAfter: 1 });

    await evaluate({ rules: [rule], world: world(), repo });
    subjects = [];
    await evaluate({ rules: [rule], world: world({ now: NOW + 1000 }), repo });
    subjects = ['a'];
    const again = await evaluate({ rules: [rule], world: world({ now: NOW + 2000 }), repo });

    expect(again.map((t) => t.kind)).toEqual(['fired']);
    expect(await repo.recent()).toHaveLength(2);
  });

  it('keeps the newest wording, so a changing detail is not stale', async () => {
    let restarts = 3;
    const rule: AlertRule = {
      id: 'test-rule',
      title: 'Test',
      severity: 'warning',
      fireAfter: 1,
      resolveAfter: 1,
      observe: () => [{ subject: 'a', summary: `restarted ${restarts} times` }],
    };

    await evaluate({ rules: [rule], world: world(), repo });
    restarts = 9;
    await evaluate({ rules: [rule], world: world({ now: NOW + 1000 }), repo });

    expect((await repo.firing())[0]?.summary).toBe('restarted 9 times');
  });
});
