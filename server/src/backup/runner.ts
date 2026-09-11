import type { Kysely } from 'kysely';
import type { BackupConfig } from '../config.js';
import type { BackupRecord, BackupsRepo } from '../db/backups.repo.js';
import type { Database } from '../db/schema.js';
import { DEFAULT_SCHEDULE } from '../settings/documents.js';
import { identityEncrypter, recipientEncrypter } from './age.js';
import { S3Client } from './s3.js';
import { BackupScheduler } from './scheduler.js';
import { type BackupOutcome, type Encrypter, runBackup } from './service.js';

export type BackupStatus =
  | { configured: false; backups: [] }
  | {
      configured: true;
      bucket: string;
      endpoint: string;
      /** `none`, `write-only` (kubitor cannot read it back) or `readable`. */
      encryption: 'none' | 'write-only' | 'readable';
      schedule: string;
      nextRunAt: number | null;
      newestVerifiedAt: number | null;
      running: boolean;
      backups: BackupRecord[];
    };

export interface BackupRunnerDeps {
  /**
   * The destination as it is now, or nothing.
   *
   * A supplier rather than a value because the bucket is edited in the
   * dashboard: the S3 client, the encrypter and the schedule are all rebuilt
   * when it changes, and a server that had none at boot must be able to acquire
   * one without restarting.
   */
  config(): BackupConfig | null;
  db: Kysely<Database>;
  records: BackupsRepo;
  now(): Date;
  fetch?: typeof globalThis.fetch;
  workDir?: string;
  log?(message: string): void;
}

/**
 * Everything the backup feature is, assembled once.
 *
 * Exists so the composition root does not have to know how a scheduler, an S3
 * client and an encrypter fit together, and so the HTTP layer has one object to
 * ask rather than four.
 */
export class BackupRunner {
  readonly #deps: BackupRunnerDeps;
  readonly #scheduler: BackupScheduler;
  #current: BackupConfig | null = null;
  #schedule: string;
  #s3: S3Client | null = null;
  #encrypter: Encrypter | null = null;
  #running = false;

  constructor(deps: BackupRunnerDeps) {
    this.#deps = deps;
    this.#schedule = DEFAULT_SCHEDULE;

    this.#scheduler = new BackupScheduler({
      schedule: DEFAULT_SCHEDULE,
      now: deps.now,
      // Guarded, because the tick keeps running on an install that has no
      // destination: an error every night would be noise, not information.
      run: async () => {
        if (this.configured) await this.runNow();
      },
      onError: (error) => deps.log?.(`backup scheduler: ${String(error)}`),
    });

    this.#refresh();
  }

  get configured(): boolean {
    return this.#refresh() !== null;
  }

  start(): void {
    this.#scheduler.start();
  }

  stop(): void {
    this.#scheduler.stop();
  }

  async runNow(): Promise<BackupOutcome> {
    const config = this.#refresh();
    if (!config || !this.#s3) throw new Error('no bucket is configured');

    this.#running = true;
    try {
      return await runBackup({
        db: this.#deps.db,
        records: this.#deps.records,
        s3: this.#s3,
        encrypter: this.#encrypter,
        now: this.#deps.now,
        ...(this.#deps.workDir === undefined ? {} : { workDir: this.#deps.workDir }),
        ...(this.#deps.log === undefined ? {} : { log: this.#deps.log }),
      });
    } finally {
      this.#running = false;
    }
  }

  async status(): Promise<BackupStatus> {
    const config = this.#refresh();
    if (!config) return { configured: false, backups: [] };

    const [backups, newest] = await Promise.all([
      this.#deps.records.recent(),
      this.#deps.records.newestVerified(),
    ]);

    return {
      configured: true,
      bucket: config.bucket,
      endpoint: config.endpoint,
      encryption: encryptionMode(config),
      schedule: config.schedule,
      nextRunAt: this.#scheduler.next()?.getTime() ?? null,
      newestVerifiedAt: newest?.startedAt ?? null,
      running: this.#running,
      backups,
    };
  }

  /**
   * The destination as it is now, rebuilding what depends on it if it moved.
   *
   * Compared by reference: `SettingsService` replaces the whole configuration
   * object on every write, so identity answers "has this changed" exactly, and
   * an S3 client is not something to rebuild on every tick.
   */
  #refresh(): BackupConfig | null {
    const config = this.#deps.config();
    if (config === this.#current) return config;

    this.#current = config;
    this.#s3 = config
      ? new S3Client({ config, fetch: this.#deps.fetch ?? globalThis.fetch, now: this.#deps.now })
      : null;
    this.#encrypter = config ? encrypterFor(config) : null;

    if (config && config.schedule !== this.#schedule) {
      this.#schedule = config.schedule;
      this.#scheduler.setSchedule(config.schedule);
    }

    return config;
  }
}

function encrypterFor(config: BackupConfig): Encrypter | null {
  if (!config.ageRecipient) return null;
  return config.ageIdentity
    ? identityEncrypter(config.ageIdentity, config.ageRecipient)
    : recipientEncrypter(config.ageRecipient);
}

function encryptionMode(
  config: BackupConfig,
): Extract<BackupStatus, { configured: true }>['encryption'] {
  if (!config.ageRecipient) return 'none';
  return config.ageIdentity ? 'readable' : 'write-only';
}
