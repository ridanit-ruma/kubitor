import { describe, expect, it } from 'vitest';
import { hashPassword, SCRYPT_PARAMS, verifyPassword } from './password.js';

describe('password hashing', () => {
  it('accepts the password it hashed', async () => {
    const stored = await hashPassword('correct horse battery staple');

    expect(await verifyPassword('correct horse battery staple', stored)).toBe(true);
  });

  it('rejects a different password', async () => {
    const stored = await hashPassword('correct horse battery staple');

    expect(await verifyPassword('Correct horse battery staple', stored)).toBe(false);
  });

  it('salts, so the same password hashes differently every time', async () => {
    expect(await hashPassword('same')).not.toBe(await hashPassword('same'));
  });

  it('records the parameters it used', async () => {
    const stored = await hashPassword('x');
    const [scheme, n, r, p] = stored.split('$');

    expect(scheme).toBe('scrypt');
    expect(Number(n)).toBe(SCRYPT_PARAMS.N);
    expect(Number(r)).toBe(SCRYPT_PARAMS.r);
    expect(Number(p)).toBe(SCRYPT_PARAMS.p);
  });

  /**
   * Parameters are read back from the stored string, so raising the constant
   * must not lock existing users out of their own accounts.
   */
  it('still verifies a hash written with weaker parameters', async () => {
    const legacy = await hashPassword('x', { N: 1 << 12, r: 8, p: 1, keylen: 32 });

    expect(await verifyPassword('x', legacy)).toBe(true);
  });

  it('rejects a tampered hash', async () => {
    const stored = await hashPassword('x');
    const tampered = `${stored.slice(0, -1)}${stored.at(-1) === 'a' ? 'b' : 'a'}`;

    expect(await verifyPassword('x', tampered)).toBe(false);
  });

  it('returns false rather than throwing on a malformed stored value', async () => {
    for (const bad of ['', 'garbage', 'scrypt$16384', 'scrypt$a$b$c$d$e', 'bcrypt$1$2$3$4$5']) {
      expect(await verifyPassword('x', bad), bad).toBe(false);
    }
  });

  it('rejects a hash whose parameters are absurd, rather than allocating for it', async () => {
    const hostile = `scrypt$${2 ** 30}$8$1$00$00`;

    expect(await verifyPassword('x', hostile)).toBe(false);
  });
});
