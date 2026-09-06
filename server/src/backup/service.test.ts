import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BackupsRepo } from '../db/backups.repo.js';
import { createDb } from '../db/connect.js';
import { migrateToLatest } from '../db/migrate.js';
import { S3Client } from './s3.js';
import { MAX_ENCRYPTED_BYTES, objectName, runBackup } from './service.js';

const AT = new Date('2026-09-06T03:17:00Z');

let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(process.cwd(), '.tmptest', 'backup-'));
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

/** A bucket in memory, so the whole write-then-read-back path is exercised. */
function bucket() {
  const objects = new Map<string, Uint8Array>();

  const fake: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const key = url.pathname.replace('/kubitor-backups/', '');

    if (init?.method === 'PUT') {
      objects.set(key, new Uint8Array(init.body as Uint8Array));
      return new Response('', { status: 200 });
    }
    const stored = objects.get(key);
    if (!stored) return new Response('<Error><Code>NoSuchKey</Code></Error>', { status: 404 });
    return new Response(stored, { status: 200 });
  };

  const client = new S3Client({
    config: {
      endpoint: 'https://s3.example.com',
      bucket: 'kubitor-backups',
      prefix: '',
      accessKey: 'AKIDEXAMPLE',
      secretKey: 'secret',
      region: 'us-east-1',
    },
    fetch: fake,
    now: () => AT,
  });

  return { objects, client };
}

async function harness(options: { encrypter?: boolean; corrupt?: boolean } = {}) {
  const db = createDb({ kind: 'sqlite', sqlitePath: join(directory, 'live.db') });
  await migrateToLatest(db, 'sqlite');
  await db
    .insertInto('agent_tokens')
    .values({ node: 'ken', token_hash: 'h', created_at: 1, last_seen_at: null })
    .execute();

  const store = bucket();
  const records = new BackupsRepo(db);

  // Reversible and not cryptography: this test is about the pipeline's shape,
  // and a real age round trip is covered where the encrypter is built.
  const encrypter = options.encrypter
    ? {
        readable: true,
        encrypt: async (plain: Uint8Array) => Uint8Array.from(plain, (byte) => byte ^ 0x5a),
        decrypt: async (cipher: Uint8Array) =>
          options.corrupt
            ? new Uint8Array(cipher.length)
            : Uint8Array.from(cipher, (byte) => byte ^ 0x5a),
      }
    : null;

  return { db, store, records, encrypter };
}

describe('objectName', () => {
  it('sorts chronologically in any listing', () => {
    expect(objectName(AT, false)).toBe('kubitor-20260906T031700Z.db');
    expect(objectName(AT, true)).toBe('kubitor-20260906T031700Z.db.age');
    expect(objectName(new Date('2026-01-02T00:00:00Z'), false) < objectName(AT, false)).toBe(true);
  });
});

describe('runBackup', () => {
  it('writes a database to the bucket and records it', async () => {
    const { db, store, records, encrypter } = await harness();

    const outcome = await runBackup({
      db,
      records,
      s3: store.client,
      encrypter,
      now: () => AT,
      workDir: directory,
    });

    expect(outcome.error ?? null).toBeNull();
    expect(outcome.ok).toBe(true);
    expect(store.objects.has('kubitor-20260906T031700Z.db')).toBe(true);

    const [record] = await records.recent();
    expect(record).toMatchObject({ ok: true, verified: true, encrypted: false });
    expect(record?.bytes).toBeGreaterThan(0);
    await db.destroy();
  });

  /** What lands in the bucket must not be readable by whoever holds the bucket. */
  it('uploads ciphertext when a recipient is configured', async () => {
    const { db, store, records, encrypter } = await harness({ encrypter: true });

    await runBackup({
      db,
      records,
      s3: store.client,
      encrypter,
      now: () => AT,
      workDir: directory,
    });

    const stored = store.objects.get('kubitor-20260906T031700Z.db.age');
    expect(stored).toBeDefined();
    // A SQLite file starts with this; ciphertext must not.
    expect(new TextDecoder().decode(stored?.slice(0, 15))).not.toBe('SQLite format 3');

    const [record] = await records.recent();
    expect(record).toMatchObject({ ok: true, encrypted: true, verified: true });
    await db.destroy();
  });

  /**
   * The reason verification exists. A wrong recipient, a truncated upload and a
   * mis-signed request all produce an object that is not a database, and all of
   * them otherwise look like success until the day of the restore.
   */
  it('fails the backup when what comes back is not a database', async () => {
    const { db, store, records, encrypter } = await harness({ encrypter: true, corrupt: true });

    const outcome = await runBackup({
      db,
      records,
      s3: store.client,
      encrypter,
      now: () => AT,
      workDir: directory,
    });

    expect(outcome.ok).toBe(false);
    const [record] = await records.recent();
    expect(record).toMatchObject({ ok: false, verified: false });
    expect(record?.error).toBeTruthy();
    await db.destroy();
  });

  it('records a bucket that refused the upload, with the reason', async () => {
    const { db, records } = await harness();
    const refusing = new S3Client({
      config: {
        endpoint: 'https://s3.example.com',
        bucket: 'b',
        prefix: '',
        accessKey: 'a',
        secretKey: 's',
        region: 'us-east-1',
      },
      fetch: async () => new Response('<Error><Code>AccessDenied</Code></Error>', { status: 403 }),
      now: () => AT,
    });

    const outcome = await runBackup({
      db,
      records,
      s3: refusing,
      encrypter: null,
      now: () => AT,
      workDir: directory,
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain('AccessDenied');
    await db.destroy();
  });

  /** A failed backup must leave the server running, not throw into its loop. */
  it('never throws at its caller', async () => {
    const { db, records } = await harness();
    const broken = new S3Client({
      config: {
        endpoint: 'https://s3.example.com',
        bucket: 'b',
        prefix: '',
        accessKey: 'a',
        secretKey: 's',
        region: 'us-east-1',
      },
      fetch: async () => {
        throw new Error('connection reset');
      },
      now: () => AT,
    });

    await expect(
      runBackup({
        db,
        records,
        s3: broken,
        encrypter: null,
        now: () => AT,
        workDir: directory,
      }),
    ).resolves.toMatchObject({ ok: false });
    await db.destroy();
  });

  it('leaves no snapshot behind, successful or not', async () => {
    const { db, store, records } = await harness();
    const { readdirSync } = await import('node:fs');

    await runBackup({
      db,
      records,
      s3: store.client,
      encrypter: null,
      now: () => AT,
      workDir: directory,
    });

    expect(readdirSync(directory).filter((name) => name.startsWith('kubitor-backup-'))).toEqual([]);
    await db.destroy();
  });

  /**
   * The configuration the design recommends: kubitor holds the recipient and no
   * identity, so it cannot open what it wrote. Verification then proves the
   * bucket holds exactly the bytes that were sent, and the snapshot was opened
   * before it left — which is what makes that trade honest rather than a gap.
   */
  it('verifies a backup it is unable to read', async () => {
    const { db, store, records } = await harness();
    const writeOnly = {
      readable: false,
      encrypt: async (plain: Uint8Array) => Uint8Array.from(plain, (byte) => byte ^ 0x5a),
      decrypt: async () => {
        throw new Error('kubitor holds no identity');
      },
    };

    const outcome = await runBackup({
      db,
      records,
      s3: store.client,
      encrypter: writeOnly,
      now: () => AT,
      workDir: directory,
    });

    expect(outcome.error ?? null).toBeNull();
    expect(outcome.ok).toBe(true);
    const [record] = await records.recent();
    expect(record).toMatchObject({ ok: true, encrypted: true, verified: true });
  });

  /** Storage that returns something other than what it was given. */
  it('fails when the bucket gives back different bytes', async () => {
    const { db, records } = await harness();
    const lying = new S3Client({
      config: {
        endpoint: 'https://s3.example.com',
        bucket: 'b',
        prefix: '',
        accessKey: 'a',
        secretKey: 's',
        region: 'us-east-1',
      },
      fetch: async (_input, init) =>
        init?.method === 'PUT'
          ? new Response('', { status: 200 })
          : new Response(new Uint8Array([1, 2, 3]), { status: 200 }),
      now: () => AT,
    });

    const outcome = await runBackup({
      db,
      records,
      s3: lying,
      encrypter: null,
      now: () => AT,
      workDir: directory,
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.error).toMatch(/bytes/);
  });

  it('has a limit above what a small cluster produces', () => {
    expect(MAX_ENCRYPTED_BYTES).toBeGreaterThan(100 * 1024 * 1024);
  });
});
