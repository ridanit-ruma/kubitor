import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LOCKOUT } from '../auth/login-policy.js';
import { createTestApp, seedAccount, TEST_PASSWORD, type TestApp } from '../test/app-harness.js';
import { SESSION_COOKIE } from './cookies.js';

let harness: TestApp;

function http() {
  return request(harness.app.getHttpServer());
}

/** The Set-Cookie value for the session cookie, if the response sets one. */
function setCookie(headers: Record<string, unknown>): string | undefined {
  const raw = headers['set-cookie'];
  const list = Array.isArray(raw) ? (raw as string[]) : raw ? [String(raw)] : [];
  return list.find((value) => value.startsWith(`${SESSION_COOKIE}=`));
}

async function loginCookie(username = 'admin'): Promise<string> {
  const response = await http().post('/api/auth/login').send({ username, password: TEST_PASSWORD });

  const cookie = setCookie(response.headers as Record<string, unknown>);
  if (!cookie) throw new Error('login did not set a session cookie');
  return cookie.split(';')[0] as string;
}

beforeEach(async () => {
  harness = await createTestApp();
  await seedAccount(harness, 'admin');
});

afterEach(async () => {
  await harness.close();
});

describe('POST /api/auth/login', () => {
  it('sets an HttpOnly session cookie and returns the account', async () => {
    const response = await http()
      .post('/api/auth/login')
      .send({ username: 'admin', password: TEST_PASSWORD });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ username: 'admin', mustChangePassword: false });

    const cookie = setCookie(response.headers as Record<string, unknown>);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Lax');
  });

  /** The token belongs in the cookie only; a body copy would be readable by scripts. */
  it('never puts the token in the response body', async () => {
    const response = await http()
      .post('/api/auth/login')
      .send({ username: 'admin', password: TEST_PASSWORD });

    expect(JSON.stringify(response.body)).not.toMatch(/eyJ/);
  });

  it('rejects a wrong password without setting a cookie', async () => {
    const response = await http()
      .post('/api/auth/login')
      .send({ username: 'admin', password: 'wrong' });

    expect(response.status).toBe(401);
    expect(setCookie(response.headers as Record<string, unknown>)).toBeUndefined();
  });

  it('answers an unknown username exactly as it answers a wrong password', async () => {
    const unknown = await http()
      .post('/api/auth/login')
      .send({ username: 'nobody', password: TEST_PASSWORD });
    const wrong = await http()
      .post('/api/auth/login')
      .send({ username: 'admin', password: 'wrong' });

    expect(unknown.status).toBe(wrong.status);
    expect(unknown.body).toEqual(wrong.body);
  });

  it('rejects a malformed body', async () => {
    const response = await http().post('/api/auth/login').send({ username: 'admin' });

    expect(response.status).toBe(400);
  });

  it('reports Retry-After once the address is locked out', async () => {
    for (let i = 0; i < LOCKOUT.threshold; i += 1) {
      await http().post('/api/auth/login').send({ username: 'admin', password: 'wrong' });
    }

    const response = await http()
      .post('/api/auth/login')
      .send({ username: 'admin', password: TEST_PASSWORD });

    expect(response.status).toBe(401);
    expect(Number(response.headers['retry-after'])).toBe(LOCKOUT.cooldownMs / 1000);
  });
});

describe('GET /api/auth/me', () => {
  it('returns the signed-in account', async () => {
    const cookie = await loginCookie();

    const response = await http().get('/api/auth/me').set('Cookie', cookie);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ username: 'admin', mustChangePassword: false });
  });

  it('rejects a request with no cookie', async () => {
    expect((await http().get('/api/auth/me')).status).toBe(401);
  });

  it('rejects a forged token', async () => {
    const response = await http()
      .get('/api/auth/me')
      .set('Cookie', `${SESSION_COOKIE}=not.a.token`);

    expect(response.status).toBe(401);
  });

  it('rejects a token whose session has been revoked', async () => {
    const cookie = await loginCookie();
    await harness.db.deleteFrom('sessions').execute();

    expect((await http().get('/api/auth/me').set('Cookie', cookie)).status).toBe(401);
  });
});

describe('POST /api/auth/logout', () => {
  it('clears the cookie and deletes the session', async () => {
    const cookie = await loginCookie();

    const response = await http().post('/api/auth/logout').set('Cookie', cookie);

    expect(response.status).toBe(204);
    expect(setCookie(response.headers as Record<string, unknown>)).toContain('Max-Age=0');
    expect((await http().get('/api/auth/me').set('Cookie', cookie)).status).toBe(401);
  });

  it('succeeds even without a session, so a stale client can always clear itself', async () => {
    expect((await http().post('/api/auth/logout')).status).toBe(204);
  });
});

describe('forced password change', () => {
  beforeEach(async () => {
    await seedAccount(harness, 'fresh', true);
  });

  it('reports the requirement at login', async () => {
    const response = await http()
      .post('/api/auth/login')
      .send({ username: 'fresh', password: TEST_PASSWORD });

    expect(response.body.mustChangePassword).toBe(true);
  });

  it('lets the user change their password while the flag is set', async () => {
    const cookie = await loginCookie('fresh');

    const response = await http()
      .post('/api/auth/change-password')
      .set('Cookie', cookie)
      .send({ currentPassword: TEST_PASSWORD, newPassword: 'a-much-better-password' });

    expect(response.status).toBe(204);
    expect((await http().get('/api/auth/me').set('Cookie', cookie)).body.mustChangePassword).toBe(
      false,
    );
  });

  it('refuses a change without the current password', async () => {
    const cookie = await loginCookie('fresh');

    const response = await http()
      .post('/api/auth/change-password')
      .set('Cookie', cookie)
      .send({ currentPassword: 'wrong', newPassword: 'a-much-better-password' });

    expect(response.status).toBe(401);
  });

  it('refuses a new password that is too short to be worth setting', async () => {
    const cookie = await loginCookie('fresh');

    const response = await http()
      .post('/api/auth/change-password')
      .set('Cookie', cookie)
      .send({ currentPassword: TEST_PASSWORD, newPassword: 'short' });

    expect(response.status).toBe(400);
  });
});
