import { describe, expect, it, vi } from 'vitest';
import type { NotifyConfig } from '../config.js';
import { channelSource } from './source.js';

/**
 * A switch for making the build throw, so the supplier's behaviour around a
 * failure can be asserted without depending on which value happens to make
 * nodemailer unhappy this month. `build.ts` catches its own known failure; this
 * stands in for the unforeseen one.
 */
const failing = vi.hoisted(() => ({ now: false }));

vi.mock('./build.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./build.js')>();
  return {
    ...actual,
    channelsFrom: (...args: Parameters<typeof actual.channelsFrom>) => {
      if (failing.now) throw new Error('the transport could not be built');
      return actual.channelsFrom(...args);
    },
  };
});

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

  /**
   * The failure this supplier was poisoned by: marking the configuration as
   * seen before building from it meant the first caller ate the throw and every
   * later one was served the pre-edit bindings for the life of the process —
   * messages going to the old channel set while the dashboard showed the new
   * one, and nothing saying so.
   */
  describe('when a rebuild throws', () => {
    it('keeps the channels that were working and says so once', () => {
      let config: NotifyConfig = {
        discordWebhook: 'https://discord.com/api/webhooks/1/a',
        minimumSeverity: 'warning',
      };
      const logged: string[] = [];
      const channels = channelSource(
        () => config,
        (message) => logged.push(message),
      );
      expect(channels().map((each) => each.channel.id)).toEqual(['discord']);

      config = { slackWebhook: 'https://hooks.slack.com/services/b', minimumSeverity: 'warning' };
      failing.now = true;
      try {
        expect(channels().map((each) => each.channel.id)).toEqual(['discord']);
        // Ten seconds later, and every ten seconds after that: still one line.
        expect(channels().map((each) => each.channel.id)).toEqual(['discord']);
      } finally {
        failing.now = false;
      }

      expect(logged).toHaveLength(1);
      expect(logged[0]).toContain('previous ones are still in use');
    });

    it('retries on the next call rather than staying poisoned', () => {
      let config: NotifyConfig = {
        discordWebhook: 'https://discord.com/api/webhooks/1/a',
        minimumSeverity: 'warning',
      };
      const channels = channelSource(() => config);
      channels();

      config = { slackWebhook: 'https://hooks.slack.com/services/b', minimumSeverity: 'warning' };
      failing.now = true;
      try {
        channels();
      } finally {
        failing.now = false;
      }

      // The same configuration object, no longer failing: the edit takes hold
      // without a restart, which is the promise the whole feature rests on.
      expect(channels().map((each) => each.channel.id)).toEqual(['slack']);
    });
  });
});
