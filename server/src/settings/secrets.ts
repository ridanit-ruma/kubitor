import { Encrypter as AgeEncrypter, Decrypter, identityToRecipient } from 'age-encryption';
import { z } from 'zod';

/**
 * A value as it sits in the database.
 *
 * Tagged rather than bare so a dump is readable: `cipher` says plainly whether
 * what follows is a secret or a leftover from a deployment that had no key,
 * and reading one never depends on guessing which.
 */
export const SEALED = z.object({
  cipher: z.enum(['age', 'none']),
  value: z.string(),
});

export type Sealed = z.infer<typeof SEALED>;

export class SettingsKeyMissing extends Error {
  constructor() {
    super('KUBITOR_SETTINGS_KEY is not set, so a secret cannot be stored');
    this.name = 'SettingsKeyMissing';
  }
}

export interface Sealer {
  /** Whether a secret can be written at all. The UI asks before offering to. */
  readonly canSeal: boolean;
  seal(plaintext: string): Promise<Sealed>;
  open(sealed: Sealed): Promise<string>;
}

/** A value deliberately stored in the clear. Only the environment seed uses it. */
export function unsealed(value: string): Sealed {
  return { cipher: 'none', value };
}

/**
 * Sealing with an age identity from the environment.
 *
 * An identity rather than a passphrase because age's passphrase mode runs
 * scrypt at a work factor of 2^18 — about a second per value, paid on every
 * field at every boot. X25519 costs nothing measurable and the key is generated
 * by `age-keygen`, which operators already run for backups.
 */
export function ageSealer(identity: string): Sealer {
  // Derived once. `identityToRecipient` is async, so this is the promise, not
  // the string; awaiting it per seal costs nothing after the first.
  const recipient = identityToRecipient(identity);

  // A promise nobody is awaiting yet, that rejects, is an unhandled rejection —
  // and Node's default for one of those is to terminate the process. A
  // malformed identity would otherwise kill the server at boot with age's own
  // `invalid separator "1"`, which names neither the variable nor the fix. The
  // handler makes the rejection somebody's, so the failure waits for whoever
  // awaits `recipient` below.
  void recipient.catch(() => undefined);

  return {
    canSeal: true,

    async seal(plaintext) {
      const encrypter = new AgeEncrypter();
      encrypter.addRecipient(await recipient);
      const bytes = await encrypter.encrypt(plaintext);
      return { cipher: 'age', value: Buffer.from(bytes).toString('base64') };
    },

    async open(sealed) {
      if (sealed.cipher === 'none') return sealed.value;

      const decrypter = new Decrypter();
      decrypter.addIdentity(identity);
      return decrypter.decrypt(Buffer.from(sealed.value, 'base64'), 'text');
    },
  };
}

/**
 * What a deployment with no `KUBITOR_SETTINGS_KEY` gets.
 *
 * Reading keeps working, because a deployment that had no key seeded its
 * documents in the clear and must survive the upgrade. Writing a secret does
 * not: storing a Telegram token unencrypted in a file that is copied into every
 * backup is worse than refusing, and refusing is something the UI can explain.
 */
export function plaintextSealer(): Sealer {
  return {
    canSeal: false,

    async seal() {
      throw new SettingsKeyMissing();
    },

    async open(sealed) {
      if (sealed.cipher === 'age') {
        throw new Error(
          'this value was stored encrypted and KUBITOR_SETTINGS_KEY is not set to open it',
        );
      }
      return sealed.value;
    },
  };
}

/**
 * The sealer a deployment gets, with the identity proven usable first.
 *
 * Asynchronous because that proof is: the identity is checked here, once, at
 * boot, so a value pasted out of the wrong line of `age-keygen` output is a
 * startup error naming the variable rather than a failure that surfaces at the
 * first save — or, on an install that never writes a secret, never at all while
 * the process dies anyway.
 */
export async function sealerFor(identity: string | undefined): Promise<Sealer> {
  if (!identity) return plaintextSealer();

  try {
    await identityToRecipient(identity);
  } catch (error) {
    throw new Error(
      `KUBITOR_SETTINGS_KEY is not a valid age identity; generate one with age-keygen and use the AGE-SECRET-KEY-1 line, not the comments above it (${String(error)})`,
    );
  }

  return ageSealer(identity);
}
