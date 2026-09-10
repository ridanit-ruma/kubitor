import { generateIdentity } from 'age-encryption';
import { beforeAll, describe, expect, it } from 'vitest';
import { ageSealer, plaintextSealer, SettingsKeyMissing, sealerFor, unsealed } from './secrets.js';

let identity: string;

beforeAll(async () => {
  identity = await generateIdentity();
});

describe('ageSealer', () => {
  it('round-trips a secret', async () => {
    const sealer = ageSealer(identity);
    const sealed = await sealer.seal('https://discord.com/api/webhooks/1/abc');

    expect(sealed.cipher).toBe('age');
    expect(await sealer.open(sealed)).toBe('https://discord.com/api/webhooks/1/abc');
  });

  it('does not leave the plaintext in what it stores', async () => {
    const sealed = await ageSealer(identity).seal('super-secret-token');

    expect(sealed.value).not.toContain('super-secret-token');
  });

  /**
   * age is randomized, so the same plaintext seals differently every time.
   * This is why "did this field change" is decided by what the caller sent and
   * never by comparing ciphertext.
   */
  it('produces a different ciphertext each time', async () => {
    const sealer = ageSealer(identity);

    const first = await sealer.seal('same');
    const second = await sealer.seal('same');

    expect(first.value).not.toBe(second.value);
  });

  it('still reads a value that was stored in the clear', async () => {
    expect(await ageSealer(identity).open(unsealed('plain'))).toBe('plain');
  });

  it('refuses a value sealed to a different key', async () => {
    const sealed = await ageSealer(identity).seal('secret');
    const other = ageSealer(await generateIdentity());

    await expect(other.open(sealed)).rejects.toThrow();
  });
});

describe('plaintextSealer', () => {
  it('cannot store a secret, and says so before being asked to', () => {
    expect(plaintextSealer().canSeal).toBe(false);
  });

  it('throws SettingsKeyMissing rather than storing in the clear', async () => {
    await expect(plaintextSealer().seal('secret')).rejects.toThrow(SettingsKeyMissing);
  });

  /**
   * The upgrade path: a deployment with no key seeded its documents in the
   * clear, and must keep working.
   */
  it('reads back a value stored in the clear', async () => {
    expect(await plaintextSealer().open(unsealed('plain'))).toBe('plain');
  });

  it('refuses an encrypted value instead of returning ciphertext as if it were the secret', async () => {
    await expect(plaintextSealer().open({ cipher: 'age', value: 'AAAA' })).rejects.toThrow(
      /KUBITOR_SETTINGS_KEY/,
    );
  });
});

describe('sealerFor', () => {
  it('gives a sealing sealer when a key is set', () => {
    expect(sealerFor(identity).canSeal).toBe(true);
  });

  it('gives a read-only sealer when none is', () => {
    expect(sealerFor(undefined).canSeal).toBe(false);
  });
});
