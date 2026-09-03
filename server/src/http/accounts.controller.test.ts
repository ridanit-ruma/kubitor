import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, seedAccount, TEST_PASSWORD, type TestApp } from '../test/app-harness.js';
import { SESSION_COOKIE } from './cookies.js';

let harness: TestApp;
let adminCookie: string;

function http() {
  return request(harness.app.getHttpServer());
}

async function loginCookie(username: string, password = TEST_PASSWORD): Promise<string> {
  const response = await http().post('/api/auth/login').send({ username, password });
  const raw = response.headers['set-cookie'];
  const list = Array.isArray(raw) ? raw : [String(raw)];
  const cookie = list.find((value) => value.startsWith(`${SESSION_COOKIE}=`));
  if (!cookie) throw new Error(`login failed for ${username}: ${response.status}`);
  return cookie.split(';')[0] as string;
}

async function auditActions(): Promise<string[]> {
  const rows = await harness.db.selectFrom('account_events').select('action').execute();
  return rows.map((row) => row.action);
}

beforeEach(async () => {
  harness = await createTestApp();
  await seedAccount(harness, 'admin');
  adminCookie = await loginCookie('admin');
});

afterEach(async () => {
  await harness.close();
});

describe('GET /api/accounts', () => {
  it('lists accounts for a signed-in user', async () => {
    const response = await http().get('/api/accounts').set('Cookie', adminCookie);

    expect(response.status).toBe(200);
    expect(response.body.accounts).toHaveLength(1);
    expect(response.body.accounts[0].username).toBe('admin');
  });

  it('never exposes a password hash', async () => {
    const response = await http().get('/api/accounts').set('Cookie', adminCookie);

    expect(JSON.stringify(response.body)).not.toContain('scrypt');
  });

  it('rejects an anonymous caller', async () => {
    expect((await http().get('/api/accounts')).status).toBe(401);
  });

  it('rejects a caller who still owes a password change', async () => {
    await seedAccount(harness, 'fresh', true);
    const cookie = await loginCookie('fresh');

    const response = await http().get('/api/accounts').set('Cookie', cookie);

    expect(response.status).toBe(403);
    expect(response.body.error).toBe('password_change_required');
  });
});

describe('POST /api/accounts', () => {
  it('creates an account and shows its one-time password once', async () => {
    const response = await http()
      .post('/api/accounts')
      .set('Cookie', adminCookie)
      .send({ username: 'bob', currentPassword: TEST_PASSWORD });

    expect(response.status).toBe(201);
    expect(response.body.account.mustChangePassword).toBe(true);
    expect(typeof response.body.password).toBe('string');
    expect(response.body.password.length).toBeGreaterThan(16);

    // The new account can sign in with exactly that password.
    await loginCookie('bob', response.body.password);
  });

  /** A stolen session alone must not be enough to mint a second way in. */
  it('refuses without the caller re-entering their own password', async () => {
    const response = await http()
      .post('/api/accounts')
      .set('Cookie', adminCookie)
      .send({ username: 'bob', currentPassword: 'wrong' });

    expect(response.status).toBe(403);
    expect(response.body.error).toBe('reauthentication_failed');
  });

  it('refuses a duplicate username', async () => {
    const response = await http()
      .post('/api/accounts')
      .set('Cookie', adminCookie)
      .send({ username: 'admin', currentPassword: TEST_PASSWORD });

    expect(response.status).toBe(409);
  });

  it('refuses a username that is not a plain identifier', async () => {
    for (const username of ['Bob', 'has space', '../etc', '']) {
      const response = await http()
        .post('/api/accounts')
        .set('Cookie', adminCookie)
        .send({ username, currentPassword: TEST_PASSWORD });

      expect(response.status, username).toBe(400);
    }
  });
});

describe('POST /api/accounts/:id/reset-password', () => {
  it('issues a new password and revokes the target sessions', async () => {
    await seedAccount(harness, 'bob');
    const bobCookie = await loginCookie('bob');
    const bob = await harness.accounts.byUsername('bob');

    const response = await http()
      .post(`/api/accounts/${bob?.id}/reset-password`)
      .set('Cookie', adminCookie)
      .send({ currentPassword: TEST_PASSWORD });

    expect(response.status).toBe(200);
    expect((await http().get('/api/auth/me').set('Cookie', bobCookie)).status).toBe(401);
    await loginCookie('bob', response.body.password);
  });

  it('404s for an account that does not exist', async () => {
    const response = await http()
      .post('/api/accounts/00000000-0000-0000-0000-000000000000/reset-password')
      .set('Cookie', adminCookie)
      .send({ currentPassword: TEST_PASSWORD });

    expect(response.status).toBe(404);
  });
});

describe('POST /api/accounts/:id/delete', () => {
  it('deletes another account and its sessions', async () => {
    await seedAccount(harness, 'bob');
    const bobCookie = await loginCookie('bob');
    const bob = await harness.accounts.byUsername('bob');

    const response = await http()
      .post(`/api/accounts/${bob?.id}/delete`)
      .set('Cookie', adminCookie)
      .send({ currentPassword: TEST_PASSWORD });

    expect(response.status).toBe(204);
    expect(await harness.accounts.byUsername('bob')).toBeUndefined();
    expect((await http().get('/api/auth/me').set('Cookie', bobCookie)).status).toBe(401);
  });

  it('refuses to delete the caller', async () => {
    const admin = await harness.accounts.byUsername('admin');

    const response = await http()
      .post(`/api/accounts/${admin?.id}/delete`)
      .set('Cookie', adminCookie)
      .send({ currentPassword: TEST_PASSWORD });

    expect(response.status).toBe(403);
    expect(response.body.error).toBe('self');
  });

  /**
   * The self-deletion refusal is what guarantees the dashboard keeps a way in:
   * deleting anyone else needs two accounts, so one always survives.
   */
  it('always leaves at least one account behind', async () => {
    await seedAccount(harness, 'bob');
    const admin = await harness.accounts.byUsername('admin');
    const bobCookie = await loginCookie('bob');

    // bob removes admin, leaving only bob.
    const removed = await http()
      .post(`/api/accounts/${admin?.id}/delete`)
      .set('Cookie', bobCookie)
      .send({ currentPassword: TEST_PASSWORD });
    expect(removed.status).toBe(204);

    // bob is now alone and cannot remove himself.
    const bob = await harness.accounts.byUsername('bob');
    const suicide = await http()
      .post(`/api/accounts/${bob?.id}/delete`)
      .set('Cookie', bobCookie)
      .send({ currentPassword: TEST_PASSWORD });

    expect(suicide.status).toBe(403);
    expect(await harness.accounts.count()).toBe(1);
  });
});

describe('audit trail', () => {
  it('records every mutation', async () => {
    await http()
      .post('/api/accounts')
      .set('Cookie', adminCookie)
      .send({ username: 'bob', currentPassword: TEST_PASSWORD });
    const bob = await harness.accounts.byUsername('bob');
    await http()
      .post(`/api/accounts/${bob?.id}/reset-password`)
      .set('Cookie', adminCookie)
      .send({ currentPassword: TEST_PASSWORD });
    await http()
      .post(`/api/accounts/${bob?.id}/delete`)
      .set('Cookie', adminCookie)
      .send({ currentPassword: TEST_PASSWORD });

    const actions = await auditActions();

    expect(actions).toContain('create');
    expect(actions).toContain('reset_password');
    expect(actions).toContain('delete');
    expect(actions).toContain('login');
  });
});

describe('bootstrap', () => {
  it('creates the first account and does nothing on a second run', async () => {
    const fresh = await createTestApp();
    try {
      const first = await fresh.accountsService.bootstrap('admin', 'from-env', Date.now());
      const second = await fresh.accountsService.bootstrap('admin', 'from-env', Date.now());

      expect(first.created).toBe(true);
      expect(second.created).toBe(false);
      expect(await fresh.accounts.count()).toBe(1);
      expect((await fresh.accounts.byUsername('admin'))?.mustChangePassword).toBe(true);
    } finally {
      await fresh.close();
    }
  });

  it('invents a password when none is configured, and reports it once', async () => {
    const fresh = await createTestApp();
    try {
      const result = await fresh.accountsService.bootstrap('admin', undefined, Date.now());

      expect(result.generatedPassword).toBeDefined();
      expect(result.generatedPassword?.length).toBeGreaterThan(16);
    } finally {
      await fresh.close();
    }
  });

  /** A restart must never hand back an account whose password was changed. */
  it('leaves an existing account alone', async () => {
    const before = await harness.accounts.byUsername('admin');

    await harness.accountsService.bootstrap('admin', 'something-else', Date.now());

    expect((await harness.accounts.byUsername('admin'))?.passwordHash).toBe(before?.passwordHash);
  });
});
