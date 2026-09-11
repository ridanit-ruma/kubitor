import { beforeAll, beforeEach, expect, it, vi } from 'vitest';
import type { BackupConfig } from '../config.js';
import { BackupsRepo } from '../db/backups.repo.js';
import { migrateToLatest } from '../db/migrate.js';
import { describeEachDialect } from '../test/db-harness.js';
import { BackupRunner } from './runner.js';
import type { S3Deps } from './s3.js';

/**
 * Counts real `S3Client` constructions, so the "same configuration object,
 * skip the rebuild" behaviour in `BackupRunner#refresh` can be asserted from
 * outside without exposing any new internal state on `BackupRunner` itself.
 * The subclass changes nothing about behaviour — it only counts.
 */
const s3Constructions = vi.hoisted(() => ({ count: 0 }));

vi.mock('./s3.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./s3.js')>();
  return {
    ...actual,
    S3Client: class extends actual.S3Client {
      constructor(deps: S3Deps) {
        super(deps);
        s3Constructions.count += 1;
      }
    },
  };
});

const DESTINATION: BackupConfig = {
  endpoint: 'https://s3.example.com',
  bucket: 'kubitor-backups',
  prefix: '',
  accessKey: 'AKIA',
  secretKey: 's3cr3t',
  region: 'us-east-1',
  schedule: '17 3 * * *',
};

describeEachDialect('BackupRunner', (ctx) => {
  let records: BackupsRepo;

  beforeAll(async () => {
    await migrateToLatest(ctx.db, ctx.kind);
  });

  beforeEach(() => {
    records = new BackupsRepo(ctx.db);
    s3Constructions.count = 0;
  });

  const runner = (config: () => BackupConfig | null): BackupRunner =>
    new BackupRunner({
      config,
      db: ctx.db,
      records,
      now: () => new Date('2026-09-11T00:00:00Z'),
      fetch: async () => new Response('', { status: 200 }),
    });

  it('is not configured while no destination is named', async () => {
    const backup = runner(() => null);

    expect(backup.configured).toBe(false);
    expect(await backup.status()).toEqual({ configured: false, backups: [] });
  });

  /**
   * The point of the whole feature: a destination entered in the dashboard is
   * in force without a restart.
   */
  it('becomes configured when a destination appears, with no restart', async () => {
    let config: BackupConfig | null = null;
    const backup = runner(() => config);
    expect(backup.configured).toBe(false);

    config = DESTINATION;

    expect(backup.configured).toBe(true);
    expect(await backup.status()).toMatchObject({ configured: true, bucket: 'kubitor-backups' });
  });

  it('re-arms the schedule when it changes', async () => {
    let config: BackupConfig | null = DESTINATION;
    const backup = runner(() => config);
    const before = (await backup.status()) as { nextRunAt: number | null };

    config = { ...DESTINATION, schedule: '5 4 * * *' };
    const after = (await backup.status()) as { nextRunAt: number | null };

    expect(after.nextRunAt).not.toBe(before.nextRunAt);
  });

  /**
   * The counterpart to "re-arms the schedule when it changes": while the
   * configuration object is the one already in force, `#refresh` must not
   * rebuild the S3 client on every tick — that would mean a fresh HTTP client
   * (and, with an age recipient, a fresh encrypter) for every scheduler tick
   * and every status poll, for a destination that never moved.
   */
  it('does not rebuild the S3 client while the configuration object is unchanged', async () => {
    const backup = runner(() => DESTINATION);
    expect(s3Constructions.count).toBe(1);

    await backup.status();
    expect(backup.configured).toBe(true);
    await backup.status();

    expect(s3Constructions.count).toBe(1);
  });

  it('goes back to unconfigured when the destination is cleared', async () => {
    let config: BackupConfig | null = DESTINATION;
    const backup = runner(() => config);
    expect(backup.configured).toBe(true);

    config = null;

    expect(backup.configured).toBe(false);
  });

  it('reports the encryption mode of the destination it has now', async () => {
    let config: BackupConfig | null = DESTINATION;
    const backup = runner(() => config);
    expect(await backup.status()).toMatchObject({ encryption: 'none' });

    config = { ...DESTINATION, ageRecipient: 'age1qqqq' };

    expect(await backup.status()).toMatchObject({ encryption: 'write-only' });
  });

  it('refuses to run by hand with nowhere to put it', async () => {
    await expect(runner(() => null).runNow()).rejects.toThrow(/no bucket/);
  });
});
