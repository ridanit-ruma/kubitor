import type { Severity } from '../alerts/rule.js';
import type { AlertRecord } from '../db/alerts.repo.js';

export type TransitionKind = 'fired' | 'resolved';

/** One thing to tell somebody, already decided to be worth telling. */
export interface Notification {
  kind: TransitionKind;
  alert: AlertRecord;
}

export interface ChannelDeps {
  fetch: typeof globalThis.fetch;
  /** Where this kubitor lives, so a message can link back to it. */
  baseUrl: string | null;
}

/**
 * Where a notification goes.
 *
 * A channel is a first-party module with a config and a `send`, the same shape
 * as an integration and for the same reason: adding one is a pull request, not
 * a plugin runtime, and testing one needs a fake `fetch` and an assertion on
 * what it posted.
 *
 * `send` may throw. The queue above it decides what a failure means; a channel
 * that swallowed its own errors would be one that silently delivered nothing.
 */
export interface Channel {
  id: string;
  title: string;
  send(notification: Notification, deps: ChannelDeps): Promise<void>;
}

/**
 * A channel that answered with a status worth reporting.
 *
 * Typed so the status can be reported without the body. A remote's error body
 * quotes the request path often enough to be a real hazard, and for a webhook
 * the path is the credential.
 */
export class ChannelResponseError extends Error {
  readonly channelTitle: string;
  readonly status: number;

  constructor(channelTitle: string, status: number, body: string) {
    super(`${channelTitle} answered ${status}: ${body}`);
    this.name = 'ChannelResponseError';
    this.channelTitle = channelTitle;
    this.status = status;
  }

  /** What may leave this process: the shape, never the remote's words. */
  get safeMessage(): string {
    return `${this.channelTitle} answered ${this.status}`;
  }
}

/** Severities in order of how loud they are, worst first. */
export const SEVERITY_ORDER: readonly Severity[] = ['critical', 'warning'];

/** Whether a severity clears a channel's floor. */
export function atLeast(severity: string, floor: Severity): boolean {
  const rank = (value: string): number => {
    const index = SEVERITY_ORDER.indexOf(value as Severity);
    return index === -1 ? SEVERITY_ORDER.length : index;
  };
  return rank(severity) <= rank(floor);
}

/**
 * The words every channel says, so they cannot drift apart.
 *
 * Deliberately plain and deliberately short. A notification is read on a phone,
 * at the top of a busy channel, next to somebody's lunch plans; the headline
 * has to carry it on its own, and the body is what they read once it has their
 * attention.
 */
export function headline(notification: Notification): string {
  const { kind, alert } = notification;
  if (kind === 'resolved') return `Recovered: ${alert.summary}`;
  return alert.severity === 'critical' ? `CRITICAL: ${alert.summary}` : alert.summary;
}

export function body(notification: Notification, baseUrl: string | null): string {
  const { kind, alert } = notification;
  const lines: string[] = [];

  if (kind === 'fired' && alert.detail) lines.push(alert.detail);
  if (kind === 'resolved' && alert.firedAt !== null && alert.resolvedAt !== null) {
    lines.push(`Lasted ${duration(alert.resolvedAt - alert.firedAt)}.`);
  }

  lines.push(`rule ${alert.rule} - ${alert.subject}`);
  if (baseUrl) lines.push(`${baseUrl.replace(/\/+$/, '')}/alerts`);

  return lines.join('\n');
}

function duration(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}
