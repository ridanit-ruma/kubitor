import type { BackupInput, BackupView, NotifyInput, NotifyView } from '@kubitor/shared';
import type { BackupConfig, NotifyConfig } from '../config.js';
import type { SettingsRepo } from '../db/settings.repo.js';
import {
  BACKUP_KEY,
  type BackupDocument,
  EMPTY_BACKUP,
  EMPTY_NOTIFY,
  NOTIFY_KEY,
  type NotifyDocument,
  parseBackup,
  parseNotify,
} from './documents.js';
import { resolveBackup, resolveNotify } from './resolve.js';
import { type Sealed, type Sealer, unsealed } from './secrets.js';
import { mergeBackup, mergeNotify, toBackupView, toNotifyView } from './view.js';

/**
 * What the environment would have configured.
 *
 * Used exactly once, to fill a document that does not exist yet. After that the
 * database is the only source, and these values are ignored for the life of the
 * installation.
 */
export interface SettingsSeed {
  notify: NotifyConfig;
  backup: BackupConfig | null;
}

export interface SettingsServiceDeps {
  repo: SettingsRepo;
  sealer: Sealer;
  seed: SettingsSeed;
  /** From the environment, and deliberately not from the database. */
  ageIdentity?: string;
  now(): number;
  log?(message: string): void;
}

/**
 * The settings the dashboard can edit, held in memory and written through.
 *
 * Cached rather than read per use because the consumers ask on every dispatch
 * and every scheduler tick, and because building an SMTP transport is not free.
 * Every write replaces the whole configuration object, so a consumer can tell
 * that something changed by comparing references.
 */
export class SettingsService {
  readonly #deps: SettingsServiceDeps;
  #notifyDocument: NotifyDocument;
  #backupDocument: BackupDocument;
  #notify: NotifyConfig;
  #backup: BackupConfig | null;

  private constructor(
    deps: SettingsServiceDeps,
    documents: { notify: NotifyDocument; backup: BackupDocument },
    resolved: { notify: NotifyConfig; backup: BackupConfig | null },
  ) {
    this.#deps = deps;
    this.#notifyDocument = documents.notify;
    this.#backupDocument = documents.backup;
    this.#notify = resolved.notify;
    this.#backup = resolved.backup;
  }

  static async load(deps: SettingsServiceDeps): Promise<SettingsService> {
    const stored = await deps.repo.all();

    const notify = await read(
      stored[NOTIFY_KEY],
      (raw) => parseNotify(raw, deps.log),
      () => seedNotify(deps.seed.notify, deps.sealer),
      EMPTY_NOTIFY,
      async (document) => deps.repo.set(NOTIFY_KEY, document, deps.now()),
    );

    const backup = await read(
      stored[BACKUP_KEY],
      (raw) => parseBackup(raw, deps.log),
      () => seedBackup(deps.seed.backup, deps.sealer),
      EMPTY_BACKUP,
      async (document) => deps.repo.set(BACKUP_KEY, document, deps.now()),
    );

    return new SettingsService(
      deps,
      { notify, backup },
      {
        notify: await resolveNotify(notify, deps.sealer, deps.log),
        backup: await resolveBackup(backup, deps.sealer, deps.ageIdentity, deps.log),
      },
    );
  }

  get notify(): NotifyConfig {
    return this.#notify;
  }

  get backup(): BackupConfig | null {
    return this.#backup;
  }

  get canStoreSecrets(): boolean {
    return this.#deps.sealer.canSeal;
  }

  notifyView(): NotifyView {
    return toNotifyView(this.#notifyDocument, this.canStoreSecrets);
  }

  backupView(): BackupView {
    return toBackupView(this.#backupDocument, this.canStoreSecrets);
  }

  /** The field names that changed, for the audit row. Never their values. */
  async putNotify(input: NotifyInput): Promise<string[]> {
    const { document, changed } = await mergeNotify(input, this.#notifyDocument, this.#deps.sealer);
    if (changed.length === 0) return [];

    await this.#deps.repo.set(NOTIFY_KEY, document, this.#deps.now());
    this.#notifyDocument = document;
    this.#notify = await resolveNotify(document, this.#deps.sealer, this.#deps.log);

    return changed;
  }

  async putBackup(input: BackupInput): Promise<string[]> {
    const { document, changed } = await mergeBackup(input, this.#backupDocument, this.#deps.sealer);
    if (changed.length === 0) return [];

    await this.#deps.repo.set(BACKUP_KEY, document, this.#deps.now());
    this.#backupDocument = document;
    this.#backup = await resolveBackup(
      document,
      this.#deps.sealer,
      this.#deps.ageIdentity,
      this.#deps.log,
    );

    return changed;
  }
}

/**
 * One document, in the three states a row can be in.
 *
 * Missing means seed it and write it, which is what makes the environment a
 * seed rather than a second source. Unreadable means run on the empty document
 * and leave the row alone: somebody's configuration that nobody can parse is
 * still theirs, and overwriting it is not a recovery.
 */
async function read<T>(
  raw: unknown,
  parse: (raw: unknown) => T | undefined,
  seed: () => Promise<T>,
  empty: T,
  write: (document: T) => Promise<void>,
): Promise<T> {
  if (raw === undefined) {
    const seeded = await seed();
    await write(seeded);
    return seeded;
  }

  return parse(raw) ?? empty;
}

/** Sealing where possible; in the clear where the value already was. */
async function carry(value: string, sealer: Sealer): Promise<Sealed> {
  return sealer.canSeal ? sealer.seal(value) : unsealed(value);
}

async function seedNotify(config: NotifyConfig, sealer: Sealer): Promise<NotifyDocument> {
  return {
    version: 1,
    minimumSeverity: config.minimumSeverity,
    ...(config.discordWebhook
      ? { discord: { webhookUrl: await carry(config.discordWebhook, sealer) } }
      : {}),
    ...(config.slackWebhook
      ? { slack: { webhookUrl: await carry(config.slackWebhook, sealer) } }
      : {}),
    ...(config.webhookUrl ? { webhook: { url: await carry(config.webhookUrl, sealer) } } : {}),
    ...(config.telegram
      ? {
          telegram: {
            token: await carry(config.telegram.token, sealer),
            chatId: config.telegram.chatId,
          },
        }
      : {}),
    ...(config.ntfy
      ? {
          ntfy: {
            server: config.ntfy.server,
            topic: config.ntfy.topic,
            ...(config.ntfy.token ? { token: await carry(config.ntfy.token, sealer) } : {}),
          },
        }
      : {}),
    ...(config.gotify
      ? {
          gotify: {
            server: config.gotify.server,
            token: await carry(config.gotify.token, sealer),
          },
        }
      : {}),
    ...(config.smtp
      ? {
          smtp: {
            url: await carry(config.smtp.url, sealer),
            from: config.smtp.from,
            to: config.smtp.to,
          },
        }
      : {}),
  };
}

async function seedBackup(config: BackupConfig | null, sealer: Sealer): Promise<BackupDocument> {
  if (!config) return EMPTY_BACKUP;

  return {
    version: 1,
    schedule: config.schedule,
    ...(config.ageRecipient ? { ageRecipient: config.ageRecipient } : {}),
    destination: {
      endpoint: config.endpoint,
      bucket: config.bucket,
      prefix: config.prefix,
      region: config.region,
      accessKey: config.accessKey,
      secretKey: await carry(config.secretKey, sealer),
    },
  };
}
