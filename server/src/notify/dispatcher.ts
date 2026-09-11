import type { Transition } from '../alerts/evaluator.js';
import type { Severity } from '../alerts/rule.js';
import type { AlertsRepo } from '../db/alerts.repo.js';
import type { NotificationsRepo } from '../db/notifications.repo.js';
import {
  atLeast,
  type Channel,
  type ChannelDeps,
  ChannelResponseError,
  type Notification,
} from './channel.js';

/** How often the queue is drained. Fast enough to feel immediate. */
export const DRAIN_INTERVAL_MS = 10_000;

/**
 * How many times a message is worth retrying before it is abandoned.
 *
 * Six attempts on the backoff below spans about ten minutes, which covers a
 * channel restart, a rate limit and a brief outage. Past that the message is
 * stale — telling somebody about a pod that crashed an hour ago, as though it
 * were news, is worse than the screen they can already look at.
 */
export const MAX_ATTEMPTS = 6;

/** Exponential, capped, so a long outage does not become a busy loop. */
export function backoffMs(attempts: number): number {
  return Math.min(5_000 * 2 ** (attempts - 1), 300_000);
}

/**
 * What a failure may say outside this process.
 *
 * Anything else is reduced to a shape. A remote's response body can quote the
 * request path, and a header the platform refuses to build quotes the header
 * value — which for ntfy is the token. The full message still goes to the log.
 */
function safeReason(error: unknown): string {
  if (error instanceof ChannelResponseError) return error.safeMessage;
  return 'the channel could not be reached';
}

export interface ChannelBinding {
  channel: Channel;
  /** Nothing quieter than this reaches it. */
  minimumSeverity: Severity;
}

export interface DispatcherDeps {
  /**
   * The channels as they are now.
   *
   * A supplier rather than an array because these are edited in the dashboard
   * and must take effect on the next dispatch. `channelSource` memoizes the
   * rebuild; nothing here should call `channelsFrom` itself.
   */
  channels(): readonly ChannelBinding[];
  notifications: NotificationsRepo;
  alerts: AlertsRepo;
  deps: ChannelDeps;
  now(): number;
  log?(message: string): void;
}

/**
 * Turns transitions into queued messages, and queued messages into requests.
 *
 * Two halves on purpose. Queuing is synchronous with evaluation and cannot
 * fail; sending is asynchronous and fails all the time. Doing both in one step
 * would mean an unreachable Discord could slow — or stop — the loop that
 * notices things are broken, which is the one thing this must never do.
 */
export class Dispatcher {
  readonly #deps: DispatcherDeps;
  #timer: ReturnType<typeof setInterval> | null = null;
  #draining = false;

  constructor(deps: DispatcherDeps) {
    this.#deps = deps;
  }

  get configured(): boolean {
    return this.#deps.channels().length > 0;
  }

  /**
   * Starts draining, whether or not anything is configured yet.
   *
   * Unconditional on purpose: channels are added from the dashboard now, and a
   * timer that only started when a channel already existed would mean the first
   * one somebody adds never delivers until the pod restarts.
   */
  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => void this.drain(), DRAIN_INTERVAL_MS);
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  /** Queues what each channel has asked to hear about. Never throws. */
  async enqueue(transitions: readonly Transition[]): Promise<void> {
    const at = this.#deps.now();
    const bindings = this.#deps.channels();

    for (const transition of transitions) {
      for (const binding of bindings) {
        if (!atLeast(transition.alert.severity, binding.minimumSeverity)) continue;

        await this.#deps.notifications.enqueue({
          alertId: transition.alert.id,
          channel: binding.channel.id,
          kind: transition.kind,
          at,
        });
      }
    }
  }

  /**
   * Sends what is due.
   *
   * One pass, bounded, and never overlapping itself: a channel that takes
   * thirty seconds to answer must not have a second drain start behind it and
   * send everything twice.
   */
  async drain(): Promise<{ sent: number; failed: number }> {
    if (this.#draining) return { sent: 0, failed: 0 };
    this.#draining = true;

    let sent = 0;
    let failed = 0;

    try {
      const now = this.#deps.now();
      const due = await this.#deps.notifications.due(now);
      const bindings = this.#deps.channels();

      for (const message of due) {
        const binding = bindings.find((each) => each.channel.id === message.channel);
        const alert = await this.#deps.alerts.byId(message.alertId);

        // A channel that has been removed from the configuration, or an alert
        // whose row has aged out, leaves a message nobody can send. Finishing
        // it is honest; retrying it forever is not.
        if (!binding || !alert) {
          await this.#deps.notifications.giveUp(
            message.seq,
            message.attempts,
            now,
            binding ? 'the alert is no longer on record' : 'the channel is no longer configured',
          );
          failed += 1;
          continue;
        }

        const attempts = message.attempts + 1;
        try {
          await binding.channel.send({ kind: message.kind, alert }, this.#deps.deps);
          await this.#deps.notifications.delivered(message.seq, now);
          sent += 1;
        } catch (error) {
          // The full message is worth a log line; it is never worth a stored
          // row or an HTTP response, both of which a viewer-level role can read.
          const detail = error instanceof Error ? error.message : String(error);
          const reason = safeReason(error);
          failed += 1;

          if (attempts >= MAX_ATTEMPTS) {
            await this.#deps.notifications.giveUp(message.seq, attempts, now, reason);
            this.#deps.log?.(`notification to ${message.channel} abandoned: ${detail}`);
          } else {
            await this.#deps.notifications.retryAfter(
              message.seq,
              attempts,
              now + backoffMs(attempts),
              reason,
            );
            this.#deps.log?.(`notification to ${message.channel} failed, retrying: ${detail}`);
          }
        }
      }
    } catch (error) {
      // Losing the timer would end every future delivery silently.
      this.#deps.log?.(`notification drain failed: ${String(error)}`);
    } finally {
      this.#draining = false;
    }

    return { sent, failed };
  }

  /**
   * Sends one message to one channel, now, outside the queue.
   *
   * Outside the queue because a test that retried for ten minutes would answer
   * the question far too late to be useful, and because a test message has no
   * alert behind it to attach a queued row to.
   */
  async test(channelId: string, by: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const binding = this.#deps.channels().find((each) => each.channel.id === channelId);
    if (!binding) return { ok: false, error: 'that channel is not configured' };

    try {
      await binding.channel.send(testNotification(this.#deps.now(), by), this.#deps.deps);
      return { ok: true };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.#deps.log?.(`test message to ${channelId} failed: ${detail}`);
      return { ok: false, error: safeReason(error) };
    }
  }
}

/**
 * The message a test sends.
 *
 * `warning` rather than `critical` so it does not arrive looking like an
 * emergency, and the summary says "test" first: somebody reading a phone lock
 * screen has to be able to tell in one glance that nothing is wrong.
 */
function testNotification(at: number, by: string): Notification {
  return {
    kind: 'fired',
    alert: {
      id: 'notification-test',
      rule: 'notification-test',
      subject: 'kubitor',
      severity: 'warning',
      summary: 'Test message from kubitor',
      detail: `Sent by ${by} from Settings. Nothing is wrong.`,
      state: 'firing',
      seenCount: 1,
      missingCount: 0,
      firstSeenAt: at,
      lastSeenAt: at,
      firedAt: at,
      resolvedAt: null,
      attrs: {},
    },
  };
}
