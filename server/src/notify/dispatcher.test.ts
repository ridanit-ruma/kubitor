import { beforeEach, expect, it } from 'vitest';
import { AlertsRepo } from '../db/alerts.repo.js';
import { migrateToLatest } from '../db/migrate.js';
import { NotificationsRepo } from '../db/notifications.repo.js';
import { describeEachDialect } from '../test/db-harness.js';
import type { Channel, Notification } from './channel.js';
import { backoffMs, Dispatcher, MAX_ATTEMPTS } from './dispatcher.js';

const NOW = 1_756_800_000_000;

/** A channel the test drives: it records what it was asked to send, or fails. */
function recording(id = 'test') {
  const sent: Notification[] = [];
  let failWith: string | null = null;

  const channel: Channel = {
    id,
    title: id,
    async send(notification) {
      if (failWith !== null) throw new Error(failWith);
      sent.push(notification);
    },
  };

  return {
    channel,
    sent,
    fail(reason: string | null) {
      failWith = reason;
    },
  };
}

describeEachDialect('Dispatcher', (ctx) => {
  let alerts: AlertsRepo;
  let notifications: NotificationsRepo;

  beforeEach(async () => {
    await migrateToLatest(ctx.db, ctx.kind);
    await ctx.db.deleteFrom('notifications').execute();
    await ctx.db.deleteFrom('alerts').execute();

    alerts = new AlertsRepo(ctx.db, ctx.sqlHelper);
    notifications = new NotificationsRepo(ctx.db);
  });

  async function alert(id: string, severity: 'critical' | 'warning' = 'critical') {
    return alerts.create({
      id,
      rule: 'node-not-ready',
      subject: id,
      severity,
      summary: `Node ${id} is not ready`,
      detail: 'detail',
      state: 'firing',
      seenCount: 2,
      missingCount: 0,
      firstSeenAt: NOW,
      lastSeenAt: NOW,
      firedAt: NOW,
      attrs: {},
    });
  }

  function dispatcher(
    bindings: { channel: Channel; minimumSeverity?: 'critical' | 'warning' }[],
    now: () => number = () => NOW,
  ) {
    const resolved = bindings.map((each) => ({
      channel: each.channel,
      minimumSeverity: each.minimumSeverity ?? 'warning',
    }));

    return new Dispatcher({
      channels: () => resolved,
      notifications,
      alerts,
      deps: { fetch: globalThis.fetch, baseUrl: 'https://kubitor.example.com' },
      now,
    });
  }

  it('queues and sends a transition', async () => {
    const target = recording();
    const record = await alert('ken');
    const dispatch = dispatcher([{ channel: target.channel }]);

    await dispatch.enqueue([{ kind: 'fired', alert: record }]);
    expect(target.sent).toEqual([]);

    const result = await dispatch.drain();

    expect(result).toEqual({ sent: 1, failed: 0 });
    expect(target.sent[0]?.alert.subject).toBe('ken');
  });

  it('sends the recovery too', async () => {
    const target = recording();
    const record = await alert('ken');
    const dispatch = dispatcher([{ channel: target.channel }]);

    await dispatch.enqueue([{ kind: 'resolved', alert: record }]);
    await dispatch.drain();

    expect(target.sent.map((n) => n.kind)).toEqual(['resolved']);
  });

  /** Not everything belongs everywhere. */
  it("respects a channel's severity floor", async () => {
    const loud = recording('loud');
    const quiet = recording('quiet');
    const warning = await alert('calder', 'warning');

    const dispatch = dispatcher([
      { channel: loud.channel, minimumSeverity: 'critical' },
      { channel: quiet.channel, minimumSeverity: 'warning' },
    ]);

    await dispatch.enqueue([{ kind: 'fired', alert: warning }]);
    await dispatch.drain();

    expect(loud.sent).toEqual([]);
    expect(quiet.sent).toHaveLength(1);
  });

  /**
   * Delivery fails all the time and must not be lost. A restart between
   * attempts is why the backoff is a stored time rather than a sleep.
   */
  it('retries a failure later rather than dropping it', async () => {
    const target = recording();
    const record = await alert('ken');
    let now = NOW;
    const dispatch = dispatcher([{ channel: target.channel }], () => now);

    await dispatch.enqueue([{ kind: 'fired', alert: record }]);
    target.fail('rate limited');
    expect(await dispatch.drain()).toEqual({ sent: 0, failed: 1 });

    // Still inside the backoff: nothing is due yet.
    expect(await dispatch.drain()).toEqual({ sent: 0, failed: 0 });

    now = NOW + backoffMs(1) + 1;
    target.fail(null);
    expect(await dispatch.drain()).toEqual({ sent: 1, failed: 0 });
    expect(target.sent).toHaveLength(1);
  });

  it('gives up after enough attempts, and says so', async () => {
    const target = recording();
    const record = await alert('ken');
    let now = NOW;
    const dispatch = dispatcher([{ channel: target.channel }], () => now);

    await dispatch.enqueue([{ kind: 'fired', alert: record }]);
    target.fail('connection refused');

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      await dispatch.drain();
      now += backoffMs(attempt) + 1;
    }

    const [message] = await notifications.recent();
    expect(message?.finishedAt).not.toBeNull();
    expect(message?.delivered).toBe(false);
    expect(message?.error).toContain('connection refused');
    expect(await notifications.pendingCount()).toBe(0);
  });

  /**
   * A recovery arriving before the failure it recovered from is worse than
   * either arriving late.
   */
  it('delivers in the order things happened', async () => {
    const target = recording();
    const first = await alert('ken');
    const second = await alert('calder');
    const dispatch = dispatcher([{ channel: target.channel }]);

    await dispatch.enqueue([{ kind: 'fired', alert: first }]);
    await dispatch.enqueue([{ kind: 'resolved', alert: second }]);
    await dispatch.drain();

    expect(target.sent.map((n) => n.alert.subject)).toEqual(['ken', 'calder']);
  });

  /** Two drains overlapping would send everything twice. */
  it('does not run two drains at once', async () => {
    const record = await alert('ken');
    let inFlight = 0;
    let overlapped = false;

    const slow: Channel = {
      id: 'slow',
      title: 'slow',
      async send() {
        inFlight += 1;
        if (inFlight > 1) overlapped = true;
        await new Promise((resolve) => setTimeout(resolve, 20));
        inFlight -= 1;
      },
    };

    const dispatch = dispatcher([{ channel: slow }]);
    await dispatch.enqueue([{ kind: 'fired', alert: record }]);

    await Promise.all([dispatch.drain(), dispatch.drain()]);

    expect(overlapped).toBe(false);
  });

  /** A channel removed from the configuration leaves messages nobody can send. */
  it('abandons a message whose channel is gone', async () => {
    const record = await alert('ken');
    const withChannel = dispatcher([{ channel: recording('gone').channel }]);
    await withChannel.enqueue([{ kind: 'fired', alert: record }]);

    const withoutChannel = dispatcher([{ channel: recording('other').channel }]);
    await withoutChannel.drain();

    const [message] = await notifications.recent();
    expect(message?.finishedAt).not.toBeNull();
    expect(message?.error).toContain('no longer configured');
  });

  it('sends nothing when no channel is configured', async () => {
    const record = await alert('ken');
    const dispatch = dispatcher([]);

    expect(dispatch.configured).toBe(false);
    await dispatch.enqueue([{ kind: 'fired', alert: record }]);

    expect(await notifications.pendingCount()).toBe(0);
  });

  /**
   * A server that booted with no channel must still deliver once one is added,
   * or "no restart" is not true. The drain timer therefore runs unconditionally.
   */
  it('starts its timer even with nothing configured', () => {
    const dispatch = dispatcher([]);

    dispatch.start();
    expect(() => dispatch.stop()).not.toThrow();
  });

  it('sends a test message to one named channel', async () => {
    const target = recording();
    const dispatch = dispatcher([{ channel: target.channel }]);

    expect(await dispatch.test(target.channel.id, 'admin')).toEqual({ ok: true });
    expect(target.sent).toHaveLength(1);
  });

  it('says plainly in the message that it is a test, and who asked for it', async () => {
    const target = recording();
    const dispatch = dispatcher([{ channel: target.channel }]);

    await dispatch.test(target.channel.id, 'admin');

    expect(target.sent[0]?.alert.summary).toContain('Test');
    expect(target.sent[0]?.alert.detail).toContain('admin');
  });

  it('reports a channel that is not configured rather than pretending it sent', async () => {
    expect(await dispatcher([]).test('discord', 'admin')).toEqual({
      ok: false,
      error: expect.stringContaining('not configured'),
    });
  });

  /**
   * The whole reason the button exists: a webhook that is wrong fails silently
   * at 3am, and a form with no way to prove it works is a form nobody trusts.
   */
  it('reports the failure instead of throwing', async () => {
    const failing: Channel = {
      id: 'discord',
      title: 'Discord',
      async send() {
        throw new Error('Discord answered 401');
      },
    };

    expect(await dispatcher([{ channel: failing }]).test('discord', 'admin')).toEqual({
      ok: false,
      error: 'Discord answered 401',
    });
  });

  it('queues nothing to a test message, so the alerts screen stays about real alerts', async () => {
    const target = recording();
    const dispatch = dispatcher([{ channel: target.channel }]);

    await dispatch.test(target.channel.id, 'admin');

    expect(await notifications.pendingCount()).toBe(0);
  });
});

describeEachDialect('backoff', () => {
  it('grows and then stops growing, so a long outage is not a busy loop', () => {
    expect(backoffMs(1)).toBeLessThan(backoffMs(2));
    expect(backoffMs(2)).toBeLessThan(backoffMs(3));
    expect(backoffMs(20)).toBe(backoffMs(21));
    expect(backoffMs(20)).toBeLessThanOrEqual(300_000);
  });
});
