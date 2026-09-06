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
});
