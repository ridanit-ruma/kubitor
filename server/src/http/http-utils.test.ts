import { describe, expect, it } from 'vitest';
import { clientIp } from './client-ip.js';
import {
  clearedSessionCookie,
  readSessionCookie,
  SESSION_COOKIE,
  sessionCookie,
} from './cookies.js';

describe('sessionCookie', () => {
  it('keeps the token out of reach of scripts and cross-site requests', () => {
    const header = sessionCookie('token-value', { secure: true, maxAgeMs: 3_600_000 });

    expect(header).toContain(`${SESSION_COOKIE}=token-value`);
    expect(header).toContain('HttpOnly');
    expect(header).toContain('Secure');
    expect(header).toContain('SameSite=Lax');
    expect(header).toContain('Path=/');
    expect(header).toContain('Max-Age=3600');
  });

  it('omits Secure only when explicitly configured for http', () => {
    expect(sessionCookie('t', { secure: false, maxAgeMs: 1000 })).not.toContain('Secure');
  });

  it('expires the cookie when cleared', () => {
    expect(clearedSessionCookie(true)).toContain('Max-Age=0');
  });
});

describe('readSessionCookie', () => {
  it('finds the session cookie among others', () => {
    expect(readSessionCookie(`other=1; ${SESSION_COOKIE}=abc; another=2`)).toBe('abc');
  });

  it('returns undefined when absent, empty or headerless', () => {
    expect(readSessionCookie(undefined)).toBeUndefined();
    expect(readSessionCookie('other=1')).toBeUndefined();
    expect(readSessionCookie(`${SESSION_COOKIE}=`)).toBeUndefined();
  });
});

describe('clientIp', () => {
  const header = 'cf-connecting-ip';

  it('prefers the trusted header', () => {
    expect(clientIp({ [header]: '198.51.100.7' }, header, '10.0.0.1')).toBe('198.51.100.7');
  });

  it('takes only the first hop, since later entries are attacker-controlled', () => {
    expect(clientIp({ [header]: '198.51.100.7, 10.0.0.9' }, header, undefined)).toBe(
      '198.51.100.7',
    );
  });

  /**
   * The value keys throttling and lands in the audit log, so a forged header
   * must not be able to smuggle arbitrary text through it.
   */
  it('discards a header value that is not an IP', () => {
    expect(clientIp({ [header]: 'not-an-ip' }, header, '10.0.0.1')).toBe('10.0.0.1');
    expect(clientIp({ [header]: "'; DROP TABLE" }, header, undefined)).toBe('unknown');
  });

  it('falls back to the socket address, unmapping IPv4-in-IPv6', () => {
    expect(clientIp({}, header, '::ffff:203.0.113.5')).toBe('203.0.113.5');
  });

  it('accepts IPv6', () => {
    expect(clientIp({ [header]: '2001:db8::1' }, header, undefined)).toBe('2001:db8::1');
  });

  it('reports unknown rather than inventing an address', () => {
    expect(clientIp({}, header, undefined)).toBe('unknown');
  });

  it('uses the first value when the header arrives repeated', () => {
    expect(clientIp({ [header]: ['198.51.100.7', '10.0.0.9'] }, header, undefined)).toBe(
      '198.51.100.7',
    );
  });
});
