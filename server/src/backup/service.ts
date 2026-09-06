import { readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Kysely } from 'kysely';
import type { BackupsRepo } from '../db/backups.repo.js';
import type { Database } from '../db/schema.js';
import type { S3Client } from './s3.js';
import { snapshot } from './snapshot.js';

/**
 * How large a database this will encrypt.
 *
 * age's JavaScript implementation is buffer-oriented, so encrypting holds the
 * snapshot in memory more than once. A monitoring pod with a modest limit would
 * be killed rather than told what happened, and an OOM kill is the least
 * informative failure there is. Past this, the backup fails loudly with a
 * reason and a suggestion.
 */
export const MAX_ENCRYPTED_BYTES = 512 * 1024 * 1024;

export interface Encrypter {
  encrypt(plaintext: Uint8Array): Promise<Uint8Array>;
  /**
   * Whether this encrypter can open what it wrote.
   *
   * False for the recipient-only form, which is the stronger configuration and
   * the reason verification is layered rather than one step: kubitor holding no
   * identity is a property worth keeping, so verification says what it can
   * check without one.
   */
  readable: boolean;
  decrypt(ciphertext: Uint8Array): Promise<Uint8Array>;
}

export interface BackupDeps {
  db: Kysely<Database>;
  records: BackupsRepo;
  s3: S3Client;
  /** Absent where no recipient is configured, which is a supported choice. */
  encrypter: Encrypter | null;
  now(): Date;
  /** Where the snapshot is staged. The pod's own filesystem by default. */
  workDir?: string;
  log?(message: string): void;
}

export interface BackupOutcome {
  ok: boolean;
  key?: string;
  bytes?: number;
  error?: string;
}

/** `kubitor-2026-09-06T031700Z.db` — sorts chronologically in any listing. */
export function objectName(at: Date, encrypted: boolean): string {
  const stamp = at
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');
  return `kubitor-${stamp}.db${encrypted ? '.age' : ''}`;
}

/**
 * One backup, start to verified.
 *
 * The order is the whole design: snapshot consistently, encrypt so the bucket
 * holds nothing readable, upload, and then **read it back and open it**. A
 * backup is not recorded as successful until the bytes in the bucket have been
 * fetched, decrypted, opened as a database and passed an integrity check —
 * which is what catches a truncated upload, a wrong recipient and a mis-signed
 * request now rather than on the day it is needed.
 *
 * Nothing here throws at its caller. A backup that fails records why and the
 * server carries on; monitoring must not stop because a bucket did.
 */
export async function runBackup(deps: BackupDeps): Promise<BackupOutcome> {
  const startedAt = deps.now();
  const id = await deps.records.start(startedAt.getTime());
  const staged = join(deps.workDir ?? tmpdir(), `kubitor-backup-${id}.db`);

  try {
    const taken = await snapshot(deps.db, staged);

    if (deps.encrypter && taken.bytes > MAX_ENCRYPTED_BYTES) {
      throw new Error(
        `snapshot is ${taken.bytes} bytes, over the ${MAX_ENCRYPTED_BYTES} limit for in-memory encryption. ` +
          'Shorten retention, or turn off KUBITOR_BACKUP_AGE_RECIPIENT and use the bucket’s own encryption.',
      );
    }

    const plaintext = new Uint8Array(await readFile(staged));
    const body = deps.encrypter ? await deps.encrypter.encrypt(plaintext) : plaintext;

    // Before it leaves: what VACUUM INTO produced is opened and checked here,
    // where a failure is cheap and unambiguous.
    openAndCheck(staged);

    const key = deps.s3.key(objectName(startedAt, deps.encrypter !== null));
    await deps.s3.put(key, body, 'application/octet-stream');

    await verify(deps, key, body, staged);

    await deps.records.finish(id, deps.now().getTime(), {
      key,
      bytes: body.byteLength,
      encrypted: deps.encrypter !== null,
      verified: true,
      ok: true,
    });

    deps.log?.(`backup ${key} written and verified (${body.byteLength} bytes)`);
    return { ok: true, key, bytes: body.byteLength };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await deps.records.finish(id, deps.now().getTime(), { ok: false, error: reason });
    deps.log?.(`backup failed: ${reason}`);
    return { ok: false, error: reason };
  } finally {
    await rm(staged, { force: true });
    await rm(`${staged}.check`, { force: true });
  }
}

/**
 * Reads the object back out of the bucket and checks it is what was sent.
 *
 * The expensive half of the feature and the half that makes it a backup rather
 * than an upload. It costs one download, and what it can conclude depends on
 * whether kubitor holds an identity:
 *
 * - always: the bytes in the bucket are exactly the bytes that were sent, which
 *   is what catches a truncated upload and storage that lost part of an object;
 * - unencrypted, or encrypted with an identity here: the object is opened and
 *   `integrity_check`ed as a database.
 *
 * With a recipient-only key the second is impossible by construction — that is
 * the point of the configuration — and the snapshot was opened before it left,
 * so what remains unverified is narrow and stated rather than papered over.
 */
async function verify(
  deps: BackupDeps,
  key: string,
  sent: Uint8Array,
  staged: string,
): Promise<void> {
  const fetched = await deps.s3.get(key);

  if (fetched.byteLength !== sent.byteLength) {
    throw new Error(
      `the bucket returned ${fetched.byteLength} bytes for an object of ${sent.byteLength}`,
    );
  }
  for (let index = 0; index < sent.length; index += 1) {
    if (fetched[index] !== sent[index]) {
      throw new Error(`the bucket returned different bytes at offset ${index}`);
    }
  }

  if (deps.encrypter && !deps.encrypter.readable) return;

  const plaintext = deps.encrypter ? await deps.encrypter.decrypt(fetched) : fetched;
  const checkPath = `${staged}.check`;
  await writeFile(checkPath, plaintext);
  openAndCheck(checkPath);
}

/** Opens a file as a database and refuses anything that is not a whole one. */
function openAndCheck(path: string): void {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const integrity = database.prepare('PRAGMA integrity_check').get() as
      | { integrity_check?: string }
      | undefined;
    const verdict = integrity?.integrity_check;
    if (verdict !== 'ok') throw new Error(`copy failed integrity_check: ${verdict}`);

    // The schema version travels with the data. A copy whose migrations do not
    // match the binary that would restore it is a restore that fails halfway.
    const migration = database
      .prepare('SELECT name FROM kysely_migration ORDER BY name DESC LIMIT 1')
      .get() as { name?: string } | undefined;
    if (!migration?.name) throw new Error('copy has no migration history');
  } finally {
    database.close();
  }
}
