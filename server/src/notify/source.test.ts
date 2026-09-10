import { describe, expect, it } from 'vitest';
import type { NotifyConfig } from '../config.js';
import { channelSource } from './source.js';

describe('channelSource', () => {
  it('names no channel while nothing is configured', () => {
    const channels = channelSource(() => ({ minimumSeverity: 'warning' }));

    expect(channels()).toEqual([]);
  });

  it('picks up a channel added after it was built, with no restart', () => {
    let config: NotifyConfig = { minimumSeverity: 'warning' };
    const channels = channelSource(() => config);
    expect(channels()).toEqual([]);

    config = { discordWebhook: 'https://discord.com/api/webhooks/1/a', minimumSeverity: 'warning' };

    expect(channels().map((each) => each.channel.id)).toEqual(['discord']);
  });

  /**
   * Building an SMTP transport is not free, and `channelsFrom` builds one per
   * call. Rebuilding per dispatch is how a burst exhausts a mail server during
   * exactly the outage it is reporting, so the bindings are rebuilt only when
   * the configuration object is replaced.
   */
  it('reuses the bindings while the configuration is the same object', () => {
    const config: NotifyConfig = {
      discordWebhook: 'https://discord.com/api/webhooks/1/a',
      minimumSeverity: 'warning',
    };
    const channels = channelSource(() => config);

    expect(channels()).toBe(channels());
  });

  it('rebuilds when the configuration object is replaced', () => {
    let config: NotifyConfig = {
      discordWebhook: 'https://discord.com/api/webhooks/1/a',
      minimumSeverity: 'warning',
    };
    const channels = channelSource(() => config);
    const before = channels();

    config = { ...config };

    expect(channels()).not.toBe(before);
  });
});
