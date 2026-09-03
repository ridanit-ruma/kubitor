import { parseCookie, stringifySetCookie } from 'cookie';

export const SESSION_COOKIE = 'kubitor_session';

export interface CookieOptions {
  secure: boolean;
  maxAgeMs: number;
}

/**
 * `HttpOnly` keeps the token away from JavaScript, so a cross-site scripting
 * bug cannot read it. `SameSite=Lax` stops it riding along on cross-site
 * requests. `Secure` is off only for local http development.
 */
export function sessionCookie(token: string, options: CookieOptions): string {
  return stringifySetCookie({
    name: SESSION_COOKIE,
    value: token,
    httpOnly: true,
    secure: options.secure,
    sameSite: 'lax',
    path: '/',
    maxAge: Math.floor(options.maxAgeMs / 1000),
  });
}

export function clearedSessionCookie(secure: boolean): string {
  return stringifySetCookie({
    name: SESSION_COOKIE,
    value: '',
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  });
}

export function readSessionCookie(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const value = parseCookie(header)[SESSION_COOKIE];
  return value && value.length > 0 ? value : undefined;
}
