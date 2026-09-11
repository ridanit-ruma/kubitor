import { generateIdentity } from 'age-encryption';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { BackupDocument, NotifyDocument } from './documents.js';
import { EMPTY_BACKUP, EMPTY_NOTIFY } from './documents.js';
import { resolveBackup, resolveNotify } from './resolve.js';
import { ageSealer, plaintextSealer, type Sealer, unsealed } from './secrets.js';

let sealer: Sealer;

beforeAll(async () => {
  sealer = ageSealer(await generateIdentity());
});

describe('resolveNotify', () => {
  it('gives an empty configuration for an empty document', async () => {
    expect(await resolveNotify(EMPTY_NOTIFY, sealer)).toEqual({ minimumSeverity: 'warning' });
  });

  it('opens a sealed webhook back into the shape channelsFrom takes', async () => {
    const document: NotifyDocument = {
      ...EMPTY_NOTIFY,
      discord: { webhookUrl: await sealer.seal('https://discord.com/api/webhooks/1/abc') },
    };

    const config = await resolveNotify(document, sealer);

    expect(config.discordWebhook).toBe('https://discord.com/api/webhooks/1/abc');
  });

  it('carries the whole of a multi-field channel', async () => {
    const document: NotifyDocument = {
      ...EMPTY_NOTIFY,
      minimumSeverity: 'critical',
      telegram: { token: await sealer.seal('123:ABC'), chatId: '4242' },
      ntfy: { server: 'https://ntfy.sh', topic: 'kubitor' },
    };

    const config = await resolveNotify(document, sealer);

    expect(config).toEqual({
      minimumSeverity: 'critical',
      telegram: { token: '123:ABC', chatId: '4242' },
      ntfy: { server: 'https://ntfy.sh', topic: 'kubitor' },
    });
  });

  /**
   * The key was rotated or lost. Dropping the one channel that cannot be
   * opened, and saying so, leaves every other channel working; throwing would
   * take the whole server down over one field.
   */
  it('drops a channel whose secret cannot be opened, and keeps the rest', async () => {
    const log = vi.fn();
    const document: NotifyDocument = {
      ...EMPTY_NOTIFY,
      discord: { webhookUrl: { cipher: 'age', value: 'not-a-real-ciphertext' } },
      slack: { webhookUrl: unsealed('https://hooks.slack.com/services/x') },
    };

    const config = await resolveNotify(document, sealer, log);

    expect(config.discordWebhook).toBeUndefined();
    expect(config.slackWebhook).toBe('https://hooks.slack.com/services/x');
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('reads a value stored in the clear when there is no key at all', async () => {
    const document: NotifyDocument = {
      ...EMPTY_NOTIFY,
      webhook: { url: unsealed('https://example.com/hook') },
    };

    const config = await resolveNotify(document, plaintextSealer());

    expect(config.webhookUrl).toBe('https://example.com/hook');
  });
});

describe('resolveBackup', () => {
  it('is null when no destination is named, which is what turns backups off', async () => {
    expect(await resolveBackup(EMPTY_BACKUP, sealer, undefined)).toBeNull();
  });

  it('assembles the destination from the document and the identity from the environment', async () => {
    const document: BackupDocument = {
      version: 1,
      schedule: '5 4 * * *',
      ageRecipient: 'age1qqqq',
      destination: {
        endpoint: 'https://s3.example.com',
        bucket: 'kubitor-backups',
        prefix: 'prod/',
        region: 'eu-central-1',
        accessKey: 'AKIA',
        secretKey: await sealer.seal('s3cr3t'),
      },
    };

    expect(await resolveBackup(document, sealer, 'AGE-SECRET-KEY-1TEST')).toEqual({
      endpoint: 'https://s3.example.com',
      bucket: 'kubitor-backups',
      prefix: 'prod/',
      region: 'eu-central-1',
      accessKey: 'AKIA',
      secretKey: 's3cr3t',
      schedule: '5 4 * * *',
      ageRecipient: 'age1qqqq',
      ageIdentity: 'AGE-SECRET-KEY-1TEST',
    });
  });

  /**
   * A destination whose secret key cannot be opened is not a destination. Half
   * a configuration that looks configured and silently never runs is the exact
   * failure the backup feature exists to avoid.
   */
  it('is null, with a log line, when the secret key cannot be opened', async () => {
    const log = vi.fn();
    const document: BackupDocument = {
      ...EMPTY_BACKUP,
      destination: {
        endpoint: 'https://s3.example.com',
        bucket: 'b',
        prefix: '',
        region: 'us-east-1',
        accessKey: 'AKIA',
        secretKey: { cipher: 'age', value: 'not-a-real-ciphertext' },
      },
    };

    expect(await resolveBackup(document, sealer, undefined, log)).toBeNull();
    expect(log).toHaveBeenCalledTimes(1);
  });
});
