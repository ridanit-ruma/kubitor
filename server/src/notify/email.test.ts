import { describe, expect, it } from 'vitest';
import type { AlertRecord } from '../db/alerts.repo.js';
import type { ChannelDeps, Notification } from './channel.js';
import { emailChannel, type Mailer } from './email.js';

const ALERT: AlertRecord = {
  id: 'a1',
  rule: 'node-not-ready',
  subject: 'ken',
  severity: 'critical',
  summary: 'Node ken is not ready',
  detail: 'The kubelet has stopped reporting itself as ready.',
  state: 'firing',
  seenCount: 2,
  missingCount: 0,
  firstSeenAt: 1,
  lastSeenAt: 1,
  firedAt: 1,
  resolvedAt: null,
  attrs: {},
};

const DEPS: ChannelDeps = { fetch: globalThis.fetch, baseUrl: 'https://kubitor.example.com' };

function recording(fail?: string) {
  const sent: { to: string; subject: string; text: string }[] = [];

  const mailer: Mailer = {
    async send(message) {
      if (fail) throw new Error(fail);
      sent.push(message);
    },
  };

  return { mailer, sent };
}

describe('emailChannel', () => {
  /**
   * A phone's lock screen shows the subject and nothing else. A subject of
   * "kubitor alert" would make every message look identical at the moment
   * somebody most needs them not to.
   */
  it('puts the whole alert in the subject', async () => {
    const { mailer, sent } = recording();
    const fired: Notification = { kind: 'fired', alert: ALERT };

    await emailChannel(mailer, 'ops@example.com').send(fired, DEPS);

    expect(sent[0]?.subject).toContain('Node ken is not ready');
    expect(sent[0]?.to).toBe('ops@example.com');
  });

  it('says plainly in the subject when something recovered', async () => {
    const { mailer, sent } = recording();
    const resolved: Notification = { kind: 'resolved', alert: { ...ALERT, resolvedAt: 2 } };

    await emailChannel(mailer, 'ops@example.com').send(resolved, DEPS);

    expect(sent[0]?.subject).toContain('Recovered');
  });

  it('puts the detail and a link in the body', async () => {
    const { mailer, sent } = recording();

    await emailChannel(mailer, 'ops@example.com').send({ kind: 'fired', alert: ALERT }, DEPS);

    expect(sent[0]?.text).toContain('kubelet has stopped');
    expect(sent[0]?.text).toContain('https://kubitor.example.com/alerts');
  });

  /** The queue retries on a throw; swallowing here would lose the message. */
  it('throws when the mail server refuses', async () => {
    const { mailer } = recording('550 mailbox unavailable');

    await expect(
      emailChannel(mailer, 'ops@example.com').send({ kind: 'fired', alert: ALERT }, DEPS),
    ).rejects.toThrow(/550/);
  });
});
