import { generateIdentity, identityToRecipient } from 'age-encryption';
import { describe, expect, it } from 'vitest';
import { identityEncrypter, recipientEncrypter } from './age.js';

const PLAINTEXT = new TextEncoder().encode('SQLite format 3 and then some bytes');

describe('recipientEncrypter', () => {
  it('produces something the plaintext is not', async () => {
    const identity = await generateIdentity();
    const encrypter = recipientEncrypter(await identityToRecipient(identity));

    const ciphertext = await encrypter.encrypt(PLAINTEXT);

    expect(new TextDecoder().decode(ciphertext.slice(0, 15))).not.toBe('SQLite format 3');
    expect(ciphertext.byteLength).toBeGreaterThan(PLAINTEXT.byteLength);
  });

  it('produces something the matching identity can open', async () => {
    const identity = await generateIdentity();
    const recipient = await identityToRecipient(identity);

    const ciphertext = await recipientEncrypter(recipient).encrypt(PLAINTEXT);
    const opened = await identityEncrypter(identity, recipient).decrypt(ciphertext);

    expect(new TextDecoder().decode(opened)).toBe(new TextDecoder().decode(PLAINTEXT));
  });

  /**
   * The property the whole choice rests on: holding only the recipient means
   * kubitor cannot read what it wrote, so a compromised server yields nothing.
   */
  it('cannot read what it wrote', async () => {
    const identity = await generateIdentity();
    const encrypter = recipientEncrypter(await identityToRecipient(identity));

    const ciphertext = await encrypter.encrypt(PLAINTEXT);

    await expect(encrypter.decrypt(ciphertext)).rejects.toThrow(/no identity/);
  });

  it('refuses a recipient that is not one', async () => {
    await expect(recipientEncrypter('not-an-age-recipient').encrypt(PLAINTEXT)).rejects.toThrow();
  });
});

describe('identityEncrypter', () => {
  it('round-trips, so verify-on-write can open the database', async () => {
    const identity = await generateIdentity();
    const encrypter = identityEncrypter(identity, await identityToRecipient(identity));

    const opened = await encrypter.decrypt(await encrypter.encrypt(PLAINTEXT));

    expect([...opened]).toEqual([...PLAINTEXT]);
  });

  it('refuses ciphertext meant for somebody else', async () => {
    const mine = await generateIdentity();
    const theirs = await generateIdentity();

    const ciphertext = await recipientEncrypter(await identityToRecipient(theirs)).encrypt(
      PLAINTEXT,
    );

    await expect(
      identityEncrypter(mine, await identityToRecipient(mine)).decrypt(ciphertext),
    ).rejects.toThrow();
  });
});
