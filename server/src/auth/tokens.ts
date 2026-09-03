import { jwtVerify, SignJWT } from 'jose';

const ALGORITHM = 'HS256';
const ISSUER = 'kubitor';

/**
 * The token carries only a session id. Authorization state lives in the
 * `sessions` row, so a password reset or a logout revokes access immediately —
 * something a self-contained token cannot do.
 */
export interface SessionClaims {
  sid: string;
}

function key(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

export async function signSessionToken(
  sid: string,
  secret: string,
  expiresAt: number,
): Promise<string> {
  return new SignJWT({ sid })
    .setProtectedHeader({ alg: ALGORITHM })
    .setIssuer(ISSUER)
    .setIssuedAt()
    .setExpirationTime(Math.floor(expiresAt / 1000))
    .sign(key(secret));
}

/** Returns null for anything that is not a currently valid token. */
export async function verifySessionToken(
  token: string,
  secret: string,
): Promise<SessionClaims | null> {
  try {
    const { payload } = await jwtVerify(token, key(secret), {
      issuer: ISSUER,
      algorithms: [ALGORITHM],
    });

    return typeof payload.sid === 'string' && payload.sid.length > 0 ? { sid: payload.sid } : null;
  } catch {
    return null;
  }
}
