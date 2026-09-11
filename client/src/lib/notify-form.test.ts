import { type NotifyView, SECRET_KEPT } from '@kubitor/shared';
import { describe, expect, it } from 'vitest';
import { CHANNELS, isConfigured, toInput } from './notify-form';

const EMPTY: NotifyView = {
  minimumSeverity: 'warning',
  discord: { webhookUrl: null },
  slack: { webhookUrl: null },
  webhook: { url: null },
  telegram: { token: null, chatId: '' },
  ntfy: { server: '', topic: '', token: null },
  gotify: { server: '', token: null },
  smtp: { url: null, from: '', to: '' },
  canStoreSecrets: true,
};

describe('toInput', () => {
  it('drops the flag the server sends and keeps everything else', () => {
    const input = toInput({ ...EMPTY, discord: { webhookUrl: SECRET_KEPT } });

    expect(input).not.toHaveProperty('canStoreSecrets');
    expect(input.discord.webhookUrl).toBe(SECRET_KEPT);
  });
});

describe('isConfigured', () => {
  it('says a channel with nothing in it is off', () => {
    expect(isConfigured(toInput(EMPTY), 'discord')).toBe(false);
  });

  it('counts a secret the server would not show us as filled in', () => {
    const input = toInput({ ...EMPTY, discord: { webhookUrl: SECRET_KEPT } });

    expect(isConfigured(input, 'discord')).toBe(true);
  });

  it('counts a secret somebody just typed as filled in', () => {
    const input = toInput({
      ...EMPTY,
      slack: { webhookUrl: 'https://hooks.slack.com/services/x' },
    });

    expect(isConfigured(input, 'slack')).toBe(true);
  });

  /** Half a Telegram configuration sends nothing; the card must not claim it is on. */
  it('needs every required field, not just one', () => {
    const input = toInput({ ...EMPTY, telegram: { token: SECRET_KEPT, chatId: '' } });

    expect(isConfigured(input, 'telegram')).toBe(false);
  });

  it('ignores an optional field, so ntfy without a token is still on', () => {
    const input = toInput({
      ...EMPTY,
      ntfy: { server: 'https://ntfy.sh', topic: 'k', token: null },
    });

    expect(isConfigured(input, 'ntfy')).toBe(true);
  });
});

describe('CHANNELS', () => {
  it('describes every channel the view carries', () => {
    const { canStoreSecrets: _ignored, ...input } = EMPTY;

    expect(CHANNELS.map((channel) => channel.key).toSorted()).toEqual(
      Object.keys(input)
        .filter((key) => key !== 'minimumSeverity')
        .toSorted(),
    );
  });

  /**
   * The document calls it `smtp` and the dispatcher calls the channel it builds
   * `email`. The test button sends the second one, so the mapping has to be
   * written down somewhere rather than guessed at the call site.
   */
  it('carries the id the server knows each channel by', () => {
    expect(CHANNELS.find((channel) => channel.key === 'smtp')?.id).toBe('email');
    expect(CHANNELS.find((channel) => channel.key === 'discord')?.id).toBe('discord');
  });

  it('marks exactly the fields that are secrets', () => {
    const discord = CHANNELS.find((channel) => channel.key === 'discord');

    expect(discord?.fields.map((field) => [field.name, field.secret])).toEqual([
      ['webhookUrl', true],
    ]);
  });
});
