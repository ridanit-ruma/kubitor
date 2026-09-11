import { describe, expect, it } from 'vitest';
import { channelsFrom } from './build.js';

describe('channelsFrom', () => {
  /** Off until somebody gives it somewhere to send. */
  it('names no channel for an empty configuration', () => {
    expect(channelsFrom({ minimumSeverity: 'warning' })).toEqual([]);
  });

  it('builds one channel per address given', () => {
    const bindings = channelsFrom({
      discordWebhook: 'https://discord.com/api/webhooks/1/a',
      slackWebhook: 'https://hooks.slack.com/services/b',
      telegram: { token: '123:ABC', chatId: '-1001' },
      webhookUrl: 'https://example.com/hook',
      minimumSeverity: 'warning',
    });

    expect(bindings.map((b) => b.channel.id)).toEqual(['discord', 'slack', 'telegram', 'webhook']);
  });

  it('applies the severity floor to every channel', () => {
    const bindings = channelsFrom({
      discordWebhook: 'https://discord.com/api/webhooks/1/a',
      webhookUrl: 'https://example.com/hook',
      minimumSeverity: 'critical',
    });

    expect(bindings.every((b) => b.minimumSeverity === 'critical')).toBe(true);
  });

  it('builds the push and mail channels too', () => {
    const bindings = channelsFrom({
      ntfy: { server: 'https://ntfy.sh', topic: 'kubitor' },
      gotify: { server: 'https://gotify.example.com', token: 'tok' },
      smtp: { url: 'smtp://localhost:2525', from: 'kubitor@example.com', to: 'ops@example.com' },
      minimumSeverity: 'warning',
    });

    expect(bindings.map((b) => b.channel.id)).toEqual(['ntfy', 'gotify', 'email']);
  });

  /** Half a Telegram configuration is refused in config.ts, not silently built. */
  it('builds no telegram channel without both halves', () => {
    expect(channelsFrom({ minimumSeverity: 'warning' }).length).toBe(0);
  });

  /**
   * `https://mail.example.com` is the likeliest typo on a screen where every
   * other field is an https URL, and nodemailer answers it with a `TypeError`.
   * One bad item drops that item and nothing else — the rule the ingest
   * pipeline lives by. The version this replaces took the whole set with it,
   * and, through the boot-time log line that reads the set, the server.
   */
  it('drops the email channel a bad smtp URL would throw on, and keeps the rest', () => {
    const logged: string[] = [];
    const bindings = channelsFrom(
      {
        discordWebhook: 'https://discord.com/api/webhooks/1/a',
        smtp: {
          url: 'https://mail.example.com',
          from: 'kubitor@example.com',
          to: 'ops@example.com',
        },
        webhookUrl: 'https://example.com/hook',
        minimumSeverity: 'warning',
      },
      (message) => logged.push(message),
    );

    expect(bindings.map((b) => b.channel.id)).toEqual(['discord', 'webhook']);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain('smtp.url');
  });

  it('says nothing and builds nothing extra when no logger was given', () => {
    const bindings = channelsFrom({
      smtp: { url: 'https://mail.example.com', from: 'a@example.com', to: 'b@example.com' },
      minimumSeverity: 'warning',
    });

    expect(bindings).toEqual([]);
  });
});
