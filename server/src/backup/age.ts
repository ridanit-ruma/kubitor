import { Encrypter as AgeEncrypter, Decrypter } from 'age-encryption';
import type { Encrypter } from './service.js';

/**
 * Encryption to an age recipient, holding only the public half.
 *
 * The property this buys is worth stating plainly: kubitor can write backups it
 * cannot read. A compromised server, or a stolen bucket, yields ciphertext and
 * nothing else, because the identity that opens it was never here.
 *
 * The cost is that verify-on-write cannot open the database it just wrote, only
 * check that the envelope is one age produced. An operator who would rather
 * have the stronger verification keeps the identity here instead, and gives up
 * the property above; the screen says which is in force.
 */
export function recipientEncrypter(recipient: string): Encrypter {
  return {
    readable: false,

    async encrypt(plaintext: Uint8Array): Promise<Uint8Array> {
      const encrypter = new AgeEncrypter();
      encrypter.addRecipient(recipient);
      return encrypter.encrypt(plaintext);
    },

    async decrypt(): Promise<Uint8Array> {
      throw new Error('kubitor holds no identity: an encrypted backup is opened at restore time');
    },
  };
}

/**
 * An encrypter that can also read back, for an operator who keeps the identity
 * beside kubitor.
 *
 * Weaker than the recipient-only form, because a compromised server can then
 * decrypt its own history. It is offered because it is what lets verify-on-write
 * open the restored database rather than only its envelope.
 */
export function identityEncrypter(identity: string, recipient: string): Encrypter {
  return {
    readable: true,

    async encrypt(plaintext: Uint8Array): Promise<Uint8Array> {
      const encrypter = new AgeEncrypter();
      encrypter.addRecipient(recipient);
      return encrypter.encrypt(plaintext);
    },

    async decrypt(ciphertext: Uint8Array): Promise<Uint8Array> {
      const decrypter = new Decrypter();
      decrypter.addIdentity(identity);
      return decrypter.decrypt(ciphertext, 'uint8array');
    },
  };
}
