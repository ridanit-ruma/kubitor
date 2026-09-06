import { describe, expect, it } from 'vitest';
import type { AlertRecord } from '../db/alerts.repo.js';
import { atLeast, body, type ChannelDeps, headline, type Notification } from './channel.js';
import { discordChannel, slackChannel, telegramChannel, webhookChannel } from './channels.js';

const NOW = 1_756_800_000_000;

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
  firstSeenAt: NOW,
  lastSeenAt: NOW,
  firedAt: NOW,
  resolvedAt: null,
  attrs: {},
};

const FIRED: Notification = { kind: 'fired', alert: ALERT };
const RESOLVED: Notification = {
  kind: 'resolved',
  alert: { ...ALERT, resolvedAt: NOW + 3 * 3_600_000 },
};

function capturing(status = 200, bodyText = '') {
  const calls: { url: string; body: unknown }[] = [];

  const deps: ChannelDeps = {
    fetch: async (input, init) => {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
      return new Response(bodyText, { status });
    },
    baseUrl: 'https://kubitor.example.com',
  };

  return { calls, deps };
}

describe('headline and body', () => {
  it('leads with the severity when it is critical', () => {
    expect(headline(FIRED)).toContain('CRITICAL');
    expect(headline(FIRED)).toContain('Node ken is not ready');
  });

  /**
   * A channel that only ever reports bad news is one people learn to ignore,
   * so recovery has to be as legible as the failure.
   */
  it('says plainly when something recovered, and for how long it was broken', () => {
    expect(headline(RESOLVED)).toContain('Recovered');
    expect(body(RESOLVED, null)).toContain('3h');
  });

  it('links back to the screen when it knows where it lives', () => {
    expect(body(FIRED, 'https://kubitor.example.com/')).toContain(
      'https://kubitor.example.com/alerts',
    );
    expect(body(FIRED, null)).not.toContain('http');
  });

  it('names the rule and subject, so a reader can find it again', () => {
    expect(body(FIRED, null)).toContain('node-not-ready');
    expect(body(FIRED, null)).toContain('ken');
  });
});

describe('atLeast', () => {
  it('lets critical through a warning floor but not the reverse', () => {
    expect(atLeast('critical', 'warning')).toBe(true);
    expect(atLeast('warning', 'critical')).toBe(false);
    expect(atLeast('critical', 'critical')).toBe(true);
  });

  it('treats a severity it does not know as the quietest thing there is', () => {
    expect(atLeast('chatter', 'warning')).toBe(false);
  });
});

describe('discord', () => {
  it('posts content, which is the whole of the webhook contract', async () => {
    const { calls, deps } = capturing();
    await discordChannel('https://discord.com/api/webhooks/1/abc').send(FIRED, deps);

    const call = calls[0];
    expect(call?.url).toBe('https://discord.com/api/webhooks/1/abc');
    expect((call?.body as { content?: string } | undefined)?.content).toContain(
      'Node ken is not ready',
    );
  });

  /**
   * The queue retries on a throw. A channel that returned quietly on a 429
   * would drop the message that rate limit was asking it to send again.
   */
  it('throws on a refusal, carrying what the service said', async () => {
    const { deps } = capturing(429, '{"message":"You are being rate limited."}');

    await expect(discordChannel('https://discord.com/x').send(FIRED, deps)).rejects.toThrow(
      /429.*rate limited/,
    );
  });
});

describe('slack', () => {
  it('posts text, which is what Slack wants instead', async () => {
    const { calls, deps } = capturing();
    await slackChannel('https://hooks.slack.com/services/x').send(FIRED, deps);

    const call = calls[0];
    expect((call?.body as { text?: string } | undefined)?.text).toContain('Node ken is not ready');
  });
});

describe('telegram', () => {
  it('calls sendMessage on the bot, with the chat it was given', async () => {
    const { calls, deps } = capturing();
    await telegramChannel('123:ABC', '-1001').send(FIRED, deps);

    expect(calls[0]?.url).toBe('https://api.telegram.org/bot123:ABC/sendMessage');
    expect(calls[0]?.body).toMatchObject({ chat_id: '-1001' });
  });

  /** Good news does not have to buzz a phone. */
  it('sends a recovery quietly', async () => {
    const { calls, deps } = capturing();
    await telegramChannel('123:ABC', '-1001').send(RESOLVED, deps);

    expect(calls[0]?.body).toMatchObject({ disable_notification: true });
  });
});

describe('webhook', () => {
  it('sends the alert itself, so anyone with a receiver can format it', async () => {
    const { calls, deps } = capturing();
    await webhookChannel('https://example.com/hook').send(FIRED, deps);

    expect(calls[0]?.body).toMatchObject({
      kind: 'fired',
      alert: { rule: 'node-not-ready', subject: 'ken', severity: 'critical' },
    });
  });
});
