import { SECRET_KEPT } from '@kubitor/shared';
import { generateIdentity } from 'age-encryption';
import { beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { migrateToLatest } from '../db/migrate.js';
import { SettingsRepo } from '../db/settings.repo.js';
import { describeEachDialect } from '../test/db-harness.js';
import { BACKUP_KEY, NOTIFY_KEY } from './documents.js';
import { ageSealer, plaintextSealer, type Sealer } from './secrets.js';
import { type SettingsSeed, SettingsService } from './service.js';

const NOTHING: SettingsSeed = { notify: { minimumSeverity: 'warning' }, backup: null };

describeEachDialect('SettingsService', (ctx) => {
  let repo: SettingsRepo;
  let sealer: Sealer;

  beforeAll(async () => {
    await migrateToLatest(ctx.db, ctx.kind);
    sealer = ageSealer(await generateIdentity());
  });

  beforeEach(async () => {
    repo = new SettingsRepo(ctx.db, ctx.sqlHelper);
    await ctx.db.deleteFrom('settings').execute();
  });

  const load = async (
    seed: SettingsSeed = NOTHING,
    over: Partial<{ sealer: Sealer; ageIdentity: string; log(message: string): void }> = {},
  ): Promise<SettingsService> =>
    SettingsService.load({
      repo,
      sealer: over.sealer ?? sealer,
      seed,
      ...(over.ageIdentity === undefined ? {} : { ageIdentity: over.ageIdentity }),
      now: () => 1_757_000_000_000,
      ...(over.log === undefined ? {} : { log: over.log }),
    });

  it('starts with nothing configured on a fresh install', async () => {
    const settings = await load();

    expect(settings.notify).toEqual({ minimumSeverity: 'warning' });
    expect(settings.backup).toBeNull();
  });

  /**
   * The upgrade has to be silent. A deployment that sets the variable keeps
   * notifying, without anybody being told to go and re-enter it.
   */
  it('seeds the document from the environment when there is none', async () => {
    const settings = await load({
      notify: {
        discordWebhook: 'https://discord.com/api/webhooks/1/abc',
        minimumSeverity: 'critical',
      },
      backup: null,
    });

    expect(settings.notify.discordWebhook).toBe('https://discord.com/api/webhooks/1/abc');
    expect(await repo.get(NOTIFY_KEY)).toBeDefined();
  });

  it('seals what it seeds, so the environment value does not land in the clear', async () => {
    await load({
      notify: {
        discordWebhook: 'https://discord.com/api/webhooks/1/abc',
        minimumSeverity: 'warning',
      },
      backup: null,
    });

    expect(JSON.stringify(await repo.get(NOTIFY_KEY))).not.toContain('abc');
  });

  it('stores the seed in the clear when there is no key, because it already was', async () => {
    await load(
      {
        notify: { slackWebhook: 'https://hooks.slack.com/services/x', minimumSeverity: 'warning' },
        backup: null,
      },
      { sealer: plaintextSealer() },
    );

    expect(JSON.stringify(await repo.get(NOTIFY_KEY))).toContain('none');
  });

  /**
   * The rule that makes the database the only source. A second boot with a
   * different environment must not undo what somebody typed into the form.
   */
  it('ignores the environment once a document exists', async () => {
    const first = await load({
      notify: {
        discordWebhook: 'https://discord.com/api/webhooks/1/first',
        minimumSeverity: 'warning',
      },
      backup: null,
    });
    expect(first.notify.discordWebhook).toContain('first');

    const second = await load({
      notify: {
        discordWebhook: 'https://discord.com/api/webhooks/2/second',
        minimumSeverity: 'warning',
      },
      backup: null,
    });

    expect(second.notify.discordWebhook).toContain('first');
  });

  it('starts anyway on a document it cannot read, and does not overwrite it', async () => {
    const log = vi.fn();
    await repo.set(NOTIFY_KEY, { version: 99, nonsense: true }, 1);

    const settings = await load(NOTHING, { log });

    expect(settings.notify).toEqual({ minimumSeverity: 'warning' });
    expect(log).toHaveBeenCalled();
    expect(await repo.get<{ version: number }>(NOTIFY_KEY)).toMatchObject({ version: 99 });
  });

  it('takes effect immediately, with no restart', async () => {
    const settings = await load();

    await settings.putNotify({
      ...withoutFlag(settings.notifyView()),
      slack: { webhookUrl: 'https://hooks.slack.com/services/new' },
    });

    expect(settings.notify.slackWebhook).toBe('https://hooks.slack.com/services/new');
  });

  it('replaces the configuration object on a write, so consumers can compare by identity', async () => {
    const settings = await load();
    const before = settings.notify;

    await settings.putNotify({
      ...withoutFlag(settings.notifyView()),
      minimumSeverity: 'critical',
    });

    expect(settings.notify).not.toBe(before);
  });

  it('does nothing at all when the form was saved untouched', async () => {
    const settings = await load();
    const before = settings.notify;

    expect(await settings.putNotify(withoutFlag(settings.notifyView()))).toEqual([]);
    expect(settings.notify).toBe(before);
  });

  it('survives a reload, reading back what was written', async () => {
    const settings = await load();
    await settings.putNotify({
      ...withoutFlag(settings.notifyView()),
      telegram: { token: '123:ABC', chatId: '4242' },
    });

    const reloaded = await load();

    expect(reloaded.notify.telegram).toEqual({ token: '123:ABC', chatId: '4242' });
  });

  it('never hands out a secret through the view', async () => {
    const settings = await load();
    await settings.putNotify({
      ...withoutFlag(settings.notifyView()),
      telegram: { token: '123:ABC', chatId: '4242' },
    });

    expect(settings.notifyView().telegram).toEqual({ token: SECRET_KEPT, chatId: '4242' });
  });

  it('turns backups on from the form, with the identity still coming from the environment', async () => {
    const settings = await load(NOTHING, { ageIdentity: 'AGE-SECRET-KEY-1TEST' });

    await settings.putBackup({
      schedule: '5 4 * * *',
      ageRecipient: 'age1qqqq',
      destination: {
        endpoint: 'https://s3.example.com',
        bucket: 'kubitor-backups',
        prefix: '',
        region: 'eu-central-1',
        accessKey: 'AKIA',
        secretKey: 's3cr3t',
      },
    });

    expect(settings.backup).toMatchObject({
      bucket: 'kubitor-backups',
      secretKey: 's3cr3t',
      schedule: '5 4 * * *',
      ageIdentity: 'AGE-SECRET-KEY-1TEST',
    });
    expect(await repo.get(BACKUP_KEY)).toBeDefined();
  });

  it('reports which fields changed, and never their values', async () => {
    const settings = await load();

    const changed = await settings.putNotify({
      ...withoutFlag(settings.notifyView()),
      minimumSeverity: 'critical',
      discord: { webhookUrl: 'https://discord.com/api/webhooks/1/hunter2' },
    });

    expect(changed.toSorted()).toEqual(['discord.webhookUrl', 'minimumSeverity']);
    expect(changed.join()).not.toContain('hunter2');
  });

  /**
   * The boot log used to say a secret "cannot be stored" at the exact moment
   * several had been, in the clear — which is what happens to every deployment
   * upgrading into this feature, because `KUBITOR_SETTINGS_KEY` did not exist
   * before it. Naming the fields is what makes the warning actionable.
   */
  it('names the fields it is holding unencrypted', async () => {
    const settings = await load(
      {
        notify: {
          slackWebhook: 'https://hooks.slack.com/services/x',
          telegram: { token: '123:ABC', chatId: '-1001' },
          minimumSeverity: 'warning',
        },
        backup: {
          endpoint: 'https://s3.example.com',
          bucket: 'kubitor-backups',
          prefix: '',
          accessKey: 'AKIA',
          secretKey: 's3cr3t',
          region: 'us-east-1',
          schedule: '17 3 * * *',
        },
      },
      { sealer: plaintextSealer() },
    );

    expect(settings.plaintextSecrets.toSorted()).toEqual([
      'backup.destination.secretKey',
      'notify.slack.webhookUrl',
      'notify.telegram.token',
    ]);
    expect(settings.backupSecretInTheClear).toBe(true);
    expect(settings.plaintextSecrets.join()).not.toContain('s3cr3t');
  });

  it('holds nothing unencrypted once there is a key to seal with', async () => {
    const settings = await load({
      notify: { slackWebhook: 'https://hooks.slack.com/services/x', minimumSeverity: 'warning' },
      backup: null,
    });

    expect(settings.plaintextSecrets).toEqual([]);
    expect(settings.backupSecretInTheClear).toBe(false);
  });
});

function withoutFlag<T extends { canStoreSecrets: boolean }>(view: T): Omit<T, 'canStoreSecrets'> {
  const { canStoreSecrets: _ignored, ...rest } = view;
  return rest;
}
