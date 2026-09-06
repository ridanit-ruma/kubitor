import type { Kysely } from 'kysely';
import type { BackupConfig } from '../config.js';
import type { BackupRecord, BackupsRepo } from '../db/backups.repo.js';
import type { Database } from '../db/schema.js';
import { identityEncrypter, recipientEncrypter } from './age.js';
import { S3Client } from './s3.js';
import { BackupScheduler } from './scheduler.js';
import { type BackupOutcome, type Encrypter, runBackup } from './service.js';

export interface BackupStatus {
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
}

export interface BackupRunnerDeps {
  config: BackupConfig;
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
  readonly #s3: S3Client;
  readonly #encrypter: Encrypter | null;
  readonly #scheduler: BackupScheduler;
  #running = false;

  constructor(deps: BackupRunnerDeps) {
    this.#deps = deps;

    this.#s3 = new S3Client({
      config: deps.config,
      fetch: deps.fetch ?? globalThis.fetch,
      now: deps.now,
    });

    this.#encrypter = encrypterFor(deps.config);

    this.#scheduler = new BackupScheduler({
      schedule: deps.config.schedule,
      now: deps.now,
      run: () => this.runNow(),
      onError: (error) => deps.log?.(`backup scheduler: ${String(error)}`),
    });
  }

  start(): void {
    this.#scheduler.start();
  }

  stop(): void {
    this.#scheduler.stop();
  }

  async runNow(): Promise<BackupOutcome> {
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
    const [backups, newest] = await Promise.all([
      this.#deps.records.recent(),
      this.#deps.records.newestVerified(),
    ]);

    return {
      configured: true,
      bucket: this.#deps.config.bucket,
      endpoint: this.#deps.config.endpoint,
      encryption: encryptionMode(this.#deps.config),
      schedule: this.#deps.config.schedule,
      nextRunAt: this.#scheduler.next()?.getTime() ?? null,
      newestVerifiedAt: newest?.startedAt ?? null,
      running: this.#running,
      backups,
    };
  }
}

function encrypterFor(config: BackupConfig): Encrypter | null {
  if (!config.ageRecipient) return null;
  return config.ageIdentity
    ? identityEncrypter(config.ageIdentity, config.ageRecipient)
    : recipientEncrypter(config.ageRecipient);
}

function encryptionMode(config: BackupConfig): BackupStatus['encryption'] {
  if (!config.ageRecipient) return 'none';
  return config.ageIdentity ? 'readable' : 'write-only';
}
