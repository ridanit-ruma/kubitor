import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import { signSessionToken, verifySessionToken } from './tokens.js';

const SECRET = 'a'.repeat(32);
const OTHER_SECRET = 'b'.repeat(32);
const HOUR_FROM_NOW = Date.now() + 3_600_000;

describe('session tokens', () => {
  it('round-trips a session id', async () => {
    const token = await signSessionToken('sid-1', SECRET, HOUR_FROM_NOW);

    expect(await verifySessionToken(token, SECRET)).toEqual({ sid: 'sid-1' });
  });

  it('rejects a token signed with another secret', async () => {
    const token = await signSessionToken('sid-1', OTHER_SECRET, HOUR_FROM_NOW);

    expect(await verifySessionToken(token, SECRET)).toBeNull();
  });

  it('rejects an expired token', async () => {
    const token = await signSessionToken('sid-1', SECRET, Date.now() - 1000);

    expect(await verifySessionToken(token, SECRET)).toBeNull();
  });

  it('rejects a tampered payload', async () => {
    const token = await signSessionToken('sid-1', SECRET, HOUR_FROM_NOW);
    const [header, , signature] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ sid: 'sid-2' })).toString('base64url');

    expect(await verifySessionToken(`${header}.${forged}.${signature}`, SECRET)).toBeNull();
  });

  it('rejects garbage', async () => {
    for (const bad of ['', 'not-a-token', 'a.b.c']) {
      expect(await verifySessionToken(bad, SECRET), bad).toBeNull();
    }
  });

  /**
   * `alg: none` is the classic JWT forgery. jose must refuse it because the
   * algorithm is pinned, not read from the token.
   */
  it('rejects an unsigned token claiming alg none', async () => {
    const unsigned = `${Buffer.from(JSON.stringify({ alg: 'none' })).toString(
      'base64url',
    )}.${Buffer.from(JSON.stringify({ sid: 'sid-1' })).toString('base64url')}.`;

    expect(await verifySessionToken(unsigned, SECRET)).toBeNull();
  });

  it('rejects a token issued by something other than kubitor', async () => {
    const foreign = await new SignJWT({ sid: 'sid-1' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer('someone-else')
      .setExpirationTime(Math.floor(HOUR_FROM_NOW / 1000))
      .sign(new TextEncoder().encode(SECRET));

    expect(await verifySessionToken(foreign, SECRET)).toBeNull();
  });

  it('rejects a token with no session id', async () => {
    const empty = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer('kubitor')
      .setExpirationTime(Math.floor(HOUR_FROM_NOW / 1000))
      .sign(new TextEncoder().encode(SECRET));

    expect(await verifySessionToken(empty, SECRET)).toBeNull();
  });
});
