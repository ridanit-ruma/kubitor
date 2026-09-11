import { beforeEach, expect, it, vi } from 'vitest';
import { AlertsRepo } from '../db/alerts.repo.js';
import { migrateToLatest } from '../db/migrate.js';
import { NotificationsRepo } from '../db/notifications.repo.js';
import { describeEachDialect } from '../test/db-harness.js';
import { type Channel, ChannelResponseError, type Notification } from './channel.js';
import { backoffMs, Dispatcher, DRAIN_INTERVAL_MS, MAX_ATTEMPTS } from './dispatcher.js';

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
    // A bare Error carries no remote content worth keeping past the log, so
    // the stored row gets the generic shape rather than the raw message —
    // this is still "and says so": the row is finished, not silently dropped.
    expect(message?.error).toBe('the channel could not be reached');
    expect(await notifications.pendingCount()).toBe(0);
  });

  /**
   * A `ChannelResponseError` is what a real channel throws; its status is
   * worth keeping on the row, its body is not.
   */
  it('keeps the status but not the remote body in the stored row', async () => {
    const record = await alert('ken');
    let now = NOW;
    const channel: Channel = {
      id: 'discord',
      title: 'Discord',
      async send() {
        throw new ChannelResponseError('Discord', 401, 'secret-path-hunter2-should-not-appear');
      },
    };
    const dispatch = dispatcher([{ channel }], () => now);

    await dispatch.enqueue([{ kind: 'fired', alert: record }]);

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      await dispatch.drain();
      now += backoffMs(attempt) + 1;
    }

    const [message] = await notifications.recent();
    expect(message?.error).toBe('Discord answered 401');
    expect(message?.error).not.toContain('hunter2');
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
   * The behavioural claim behind the unconditional `start()`: a server that
   * booted with no channel must still deliver once one is added from the
   * dashboard, with no restart. Driving this through the real interval — not a
   * direct `drain()` call — is the point: a timer that was never armed because
   * nothing was configured yet would leave this hanging forever.
   */
  it('delivers to a channel added after start, once the drain timer fires', async () => {
    const target = recording();
    const record = await alert('ken');
    let bindings: { channel: Channel; minimumSeverity: 'critical' | 'warning' }[] = [];

    const dispatch = new Dispatcher({
      channels: () => bindings,
      notifications,
      alerts,
      deps: { fetch: globalThis.fetch, baseUrl: 'https://kubitor.example.com' },
      now: () => NOW,
    });

    vi.useFakeTimers();
    try {
      // Booted with nothing configured.
      dispatch.start();

      // The dashboard adds a channel to a server that is already running.
      bindings = [{ channel: target.channel, minimumSeverity: 'warning' }];
      await dispatch.enqueue([{ kind: 'fired', alert: record }]);

      // Let the drain timer itself fire, rather than calling drain() directly.
      await vi.advanceTimersByTimeAsync(DRAIN_INTERVAL_MS);

      expect(target.sent).toHaveLength(1);
    } finally {
      dispatch.stop();
      vi.useRealTimers();
    }
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
        throw new ChannelResponseError('Discord', 401, 'body a real Discord response would send');
      },
    };

    expect(await dispatcher([{ channel: failing }]).test('discord', 'admin')).toEqual({
      ok: false,
      error: 'Discord answered 401',
    });
  });

  /**
   * The status is worth reporting; the remote's own words are not. A
   * response body echoes the request path often enough to be a real hazard —
   * for a webhook the path is the credential.
   */
  it('never returns the remote body a channel failed with', async () => {
    const failing: Channel = {
      id: 'discord',
      title: 'Discord',
      async send() {
        throw new ChannelResponseError('Discord', 401, 'hunter2-should-not-appear');
      },
    };

    const result = await dispatcher([{ channel: failing }]).test('discord', 'admin');

    expect(result).toEqual({ ok: false, error: 'Discord answered 401' });
    expect(JSON.stringify(result)).not.toContain('hunter2');
  });

  /**
   * Not every failure is a `ChannelResponseError` — a header the platform
   * refuses to build (the ntfy token, quoted verbatim) throws a bare `Error`.
   * That message never leaves this process either.
   */
  it('reduces a bare error to a generic reason, and does not leak its message', async () => {
    const failing: Channel = {
      id: 'ntfy',
      title: 'ntfy',
      async send() {
        throw new Error('Headers.append: "Bearer hunter2-should-not-appear" is invalid');
      },
    };

    const result = await dispatcher([{ channel: failing }]).test('ntfy', 'admin');

    expect(result).toEqual({ ok: false, error: 'the channel could not be reached' });
    expect(JSON.stringify(result)).not.toContain('hunter2');
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
