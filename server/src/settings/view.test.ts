import { SECRET_KEPT } from '@kubitor/shared';
import { generateIdentity } from 'age-encryption';
import { beforeAll, describe, expect, it } from 'vitest';
import { EMPTY_BACKUP, EMPTY_NOTIFY, type NotifyDocument } from './documents.js';
import { ageSealer, plaintextSealer, type Sealer, SettingsKeyMissing } from './secrets.js';
import {
  BACKUP_INPUT,
  mergeBackup,
  mergeNotify,
  NOTIFY_INPUT,
  SettingsInvalid,
  toBackupView,
  toNotifyView,
} from './view.js';

let sealer: Sealer;

beforeAll(async () => {
  sealer = ageSealer(await generateIdentity());
});

async function withDiscord(url: string): Promise<NotifyDocument> {
  return { ...EMPTY_NOTIFY, discord: { webhookUrl: await sealer.seal(url) } };
}

describe('toNotifyView', () => {
  it('shows every channel, empty, on a fresh install', () => {
    const view = toNotifyView(EMPTY_NOTIFY, true);

    expect(view.discord.webhookUrl).toBeNull();
    expect(view.telegram).toEqual({ token: null, chatId: '' });
    expect(view.ntfy).toEqual({ server: '', topic: '', token: null });
    expect(view.canStoreSecrets).toBe(true);
  });

  it('never returns a stored secret, only that there is one', async () => {
    const view = toNotifyView(await withDiscord('https://discord.com/api/webhooks/1/abc'), true);

    expect(view.discord.webhookUrl).toBe(SECRET_KEPT);
    expect(JSON.stringify(view)).not.toContain('abc');
  });

  it('returns the fields that are not secrets, because the screen has to show them', () => {
    const document: NotifyDocument = {
      ...EMPTY_NOTIFY,
      minimumSeverity: 'critical',
      ntfy: { server: 'https://ntfy.sh', topic: 'kubitor' },
    };

    const view = toNotifyView(document, true);

    expect(view.minimumSeverity).toBe('critical');
    expect(view.ntfy).toEqual({ server: 'https://ntfy.sh', topic: 'kubitor', token: null });
  });
});

/**
 * The invariant this whole redaction scheme rests on. If saving an untouched
 * form could erase a webhook, nobody would open the form.
 */
describe('the round trip', () => {
  it('changes nothing when the notify view is sent straight back', async () => {
    const current = await withDiscord('https://discord.com/api/webhooks/1/abc');
    const { canStoreSecrets: _ignored, ...input } = toNotifyView(current, true);

    const { document, changed } = await mergeNotify(input, current, sealer);

    expect(changed).toEqual([]);
    expect(document.discord?.webhookUrl).toEqual(current.discord?.webhookUrl);
  });

  it('changes nothing when the backup view is sent straight back', async () => {
    const current = {
      ...EMPTY_BACKUP,
      schedule: '5 4 * * *',
      destination: {
        endpoint: 'https://s3.example.com',
        bucket: 'b',
        prefix: '',
        region: 'us-east-1',
        accessKey: 'AKIA',
        secretKey: await sealer.seal('s3cr3t'),
      },
    };
    const { canStoreSecrets: _ignored, ...input } = toBackupView(current, true);

    const { document, changed } = await mergeBackup(input, current, sealer);

    expect(changed).toEqual([]);
    // The ciphertext identity, not merely that a secret is still present:
    // without this the test would pass even if the secret had been
    // re-sealed or replaced.
    expect(document.destination?.secretKey).toEqual(current.destination?.secretKey);
  });
});

describe('mergeNotify', () => {
  it('replaces a secret when a new value arrives', async () => {
    const current = await withDiscord('https://discord.com/api/webhooks/1/old');
    const { canStoreSecrets: _ignored, ...input } = toNotifyView(current, true);

    const { document, changed } = await mergeNotify(
      { ...input, discord: { webhookUrl: 'https://discord.com/api/webhooks/2/new' } },
      current,
      sealer,
    );

    expect(changed).toEqual(['discord.webhookUrl']);
    if (!document.discord) throw new Error('expected the discord channel to still be set');
    expect(await sealer.open(document.discord.webhookUrl)).toBe(
      'https://discord.com/api/webhooks/2/new',
    );
  });

  it('clears a channel when its secret is emptied', async () => {
    const current = await withDiscord('https://discord.com/api/webhooks/1/abc');
    const { canStoreSecrets: _ignored, ...input } = toNotifyView(current, true);

    const { document, changed } = await mergeNotify(
      { ...input, discord: { webhookUrl: '' } },
      current,
      sealer,
    );

    expect(document.discord).toBeUndefined();
    expect(changed).toEqual(['discord.webhookUrl']);
  });

  it('records the field name and nothing that could be the value', async () => {
    const current = await withDiscord('https://discord.com/api/webhooks/1/old');
    const { canStoreSecrets: _ignored, ...input } = toNotifyView(current, true);

    const { changed } = await mergeNotify(
      { ...input, discord: { webhookUrl: 'https://discord.com/api/webhooks/2/hunter2' } },
      current,
      sealer,
    );

    expect(changed.join()).not.toContain('hunter2');
  });

  it('reports a changed severity', async () => {
    const { canStoreSecrets: _ignored, ...input } = toNotifyView(EMPTY_NOTIFY, true);

    const { changed } = await mergeNotify(
      { ...input, minimumSeverity: 'critical' },
      EMPTY_NOTIFY,
      sealer,
    );

    expect(changed).toEqual(['minimumSeverity']);
  });

  it('refuses half a Telegram configuration with the field that is missing', async () => {
    const { canStoreSecrets: _ignored, ...input } = toNotifyView(EMPTY_NOTIFY, true);

    await expect(
      mergeNotify({ ...input, telegram: { token: null, chatId: '4242' } }, EMPTY_NOTIFY, sealer),
    ).rejects.toThrow(SettingsInvalid);
  });

  it('refuses to write a secret when there is no key to seal it with', async () => {
    const { canStoreSecrets: _ignored, ...input } = toNotifyView(EMPTY_NOTIFY, false);

    await expect(
      mergeNotify(
        { ...input, slack: { webhookUrl: 'https://hooks.slack.com/services/x' } },
        EMPTY_NOTIFY,
        plaintextSealer(),
      ),
    ).rejects.toThrow(SettingsKeyMissing);
  });

  it('still lets a non-secret field be edited without a key', async () => {
    const { canStoreSecrets: _ignored, ...input } = toNotifyView(EMPTY_NOTIFY, false);

    const { changed } = await mergeNotify(
      { ...input, minimumSeverity: 'critical' },
      EMPTY_NOTIFY,
      plaintextSealer(),
    );

    expect(changed).toEqual(['minimumSeverity']);
  });
});

describe('mergeBackup', () => {
  it('keeps the schedule when the destination is cleared', async () => {
    const current = {
      ...EMPTY_BACKUP,
      schedule: '5 4 * * *',
      destination: {
        endpoint: 'https://s3.example.com',
        bucket: 'b',
        prefix: '',
        region: 'us-east-1',
        accessKey: 'AKIA',
        secretKey: await sealer.seal('s3cr3t'),
      },
    };
    const { canStoreSecrets: _ignored, ...input } = toBackupView(current, true);

    const { document } = await mergeBackup(
      { ...input, destination: { ...input.destination, bucket: '' } },
      current,
      sealer,
    );

    expect(document.destination).toBeUndefined();
    expect(document.schedule).toBe('5 4 * * *');
  });

  it('refuses a schedule that is not a cron expression, naming the field', async () => {
    const { canStoreSecrets: _ignored, ...input } = toBackupView(EMPTY_BACKUP, true);

    await expect(
      mergeBackup({ ...input, schedule: 'every tuesday' }, EMPTY_BACKUP, sealer),
    ).rejects.toMatchObject({ field: 'schedule' });
  });

  it('refuses a bucket with no secret key, which is the configuration that never runs', async () => {
    const { canStoreSecrets: _ignored, ...input } = toBackupView(EMPTY_BACKUP, true);

    await expect(
      mergeBackup(
        {
          ...input,
          destination: {
            endpoint: 'https://s3.example.com',
            bucket: 'b',
            prefix: '',
            region: 'us-east-1',
            accessKey: 'AKIA',
            secretKey: null,
          },
        },
        EMPTY_BACKUP,
        sealer,
      ),
    ).rejects.toThrow(SettingsInvalid);
  });

  it('refuses a new destination submitted with no bucket, naming the field', async () => {
    const { canStoreSecrets: _ignored, ...input } = toBackupView(EMPTY_BACKUP, true);

    await expect(
      mergeBackup(
        {
          ...input,
          destination: {
            endpoint: 'https://s3.example.com',
            bucket: '',
            prefix: '',
            region: 'us-east-1',
            accessKey: 'AKIA',
            secretKey: 's3cr3t',
          },
        },
        EMPTY_BACKUP,
        sealer,
      ),
    ).rejects.toMatchObject({ field: 'destination.bucket' });
  });
});

describe('the request schemas', () => {
  it('accept a whole view with its flag removed', () => {
    const { canStoreSecrets: _notify, ...notify } = toNotifyView(EMPTY_NOTIFY, true);
    const { canStoreSecrets: _backup, ...backup } = toBackupView(EMPTY_BACKUP, true);

    expect(NOTIFY_INPUT.safeParse(notify).success).toBe(true);
    expect(BACKUP_INPUT.safeParse(backup).success).toBe(true);
  });

  it('reject a body missing a channel entirely, rather than silently clearing it', () => {
    const { canStoreSecrets: _ignored, ...notify } = toNotifyView(EMPTY_NOTIFY, true);
    const { discord: _dropped, ...withoutDiscord } = notify;

    expect(NOTIFY_INPUT.safeParse(withoutDiscord).success).toBe(false);
  });
});
