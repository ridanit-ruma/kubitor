import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, seedAccount, TEST_PASSWORD, type TestApp } from '../test/app-harness.js';
import { SESSION_COOKIE } from './cookies.js';

let harness: TestApp;

function http() {
  return request(harness.app.getHttpServer());
}

async function cookieFor(username: string): Promise<string> {
  const response = await http().post('/api/auth/login').send({ username, password: TEST_PASSWORD });
  const raw = response.headers['set-cookie'];
  const list = Array.isArray(raw) ? raw : [String(raw)];
  const cookie = list.find((value) => value.startsWith(`${SESSION_COOKIE}=`));
  if (!cookie) throw new Error(`login failed for ${username}: ${response.status}`);
  return cookie.split(';')[0] as string;
}

beforeEach(async () => {
  harness = await createTestApp();
  await seedAccount(harness, 'boss', false, 'admin');
  await seedAccount(harness, 'ops', false, 'operator');
  await seedAccount(harness, 'guest', false, 'viewer');
});

afterEach(async () => {
  await harness.close();
});

/**
 * The client hides what a role cannot reach, and that is a courtesy. These are
 * the control: every one of these routes is reachable with a session cookie and
 * a URL, whatever the menu shows.
 */
describe('what a viewer cannot do', () => {
  const forbidden = [
    ['GET', '/api/accounts'],
    ['GET', '/api/agents'],
    ['GET', '/api/backups'],
  ] as const;

  it.each(forbidden)('is refused %s %s', async (method, path) => {
    const cookie = await cookieFor('guest');
    const response = await (method === 'GET' ? http().get(path) : http().post(path)).set(
      'Cookie',
      cookie,
    );

    expect(response.status).toBe(403);
    expect(response.body.error).toBe('forbidden');
  });

  it('cannot change an integration override', async () => {
    const cookie = await cookieFor('guest');
    const response = await http()
      .post('/api/integrations/traefik/override')
      .set('Cookie', cookie)
      .send({ override: 'force_off' });

    expect(response.status).toBe(403);
  });

  it('cannot mint an agent credential even with the right password', async () => {
    const cookie = await cookieFor('guest');
    const response = await http()
      .post('/api/agents')
      .set('Cookie', cookie)
      .send({ name: 'buildbox', currentPassword: TEST_PASSWORD });

    expect(response.status).toBe(403);
    expect(
      (
        await http()
          .get('/api/agents')
          .set('Cookie', await cookieFor('boss'))
      ).body.agents,
    ).toEqual([]);
  });

  /** kubitor is for looking at a cluster. Every role may do that. */
  it('can still read the cluster', async () => {
    const cookie = await cookieFor('guest');

    expect((await http().get('/api/facets/nodes').set('Cookie', cookie)).status).toBe(200);
    expect((await http().get('/api/overview').set('Cookie', cookie)).status).toBe(200);
    expect((await http().get('/api/capabilities').set('Cookie', cookie)).status).toBe(200);
  });
});

describe('what an operator can and cannot do', () => {
  it('may change what is installed', async () => {
    const cookie = await cookieFor('ops');
    const response = await http().post('/api/capabilities/rescan').set('Cookie', cookie);

    expect(response.status).toBe(200);
  });

  /**
   * The line that matters: an operator runs the cluster, and is not trusted
   * with the credentials that would let somebody read the estate from outside.
   */
  it('may not touch credentials', async () => {
    const cookie = await cookieFor('ops');

    expect((await http().get('/api/agents').set('Cookie', cookie)).status).toBe(403);
    expect((await http().get('/api/backups').set('Cookie', cookie)).status).toBe(403);
    expect((await http().get('/api/accounts').set('Cookie', cookie)).status).toBe(403);
  });
});

describe('the navigation a role is offered', () => {
  async function navFor(username: string): Promise<string[]> {
    const response = await http()
      .get('/api/capabilities')
      .set('Cookie', await cookieFor(username));
    return (response.body.nav as { id: string }[]).map((entry) => entry.id);
  }

  it('offers an admin everything', async () => {
    const nav = await navFor('boss');

    expect(nav).toEqual(expect.arrayContaining(['accounts', 'agents', 'backups', 'integrations']));
  });

  it('offers an operator what it installs but not what it cannot open', async () => {
    const nav = await navFor('ops');

    expect(nav).toContain('integrations');
    expect(nav).not.toContain('agents');
    expect(nav).not.toContain('backups');
    expect(nav).not.toContain('accounts');
  });

  it('offers a viewer only the cluster', async () => {
    const nav = await navFor('guest');

    expect(nav).toContain('nodes');
    expect(nav).toContain('alerts');
    expect(nav).not.toContain('integrations');
    expect(nav).not.toContain('accounts');
  });
});

describe('setting a role', () => {
  it('narrows an account, and the narrowing takes effect at once', async () => {
    const boss = await cookieFor('boss');
    const listed = await http().get('/api/accounts').set('Cookie', boss);
    const ops = (listed.body.accounts as { id: string; username: string }[]).find(
      (account) => account.username === 'ops',
    );

    const response = await http()
      .post(`/api/accounts/${ops?.id}/role`)
      .set('Cookie', boss)
      .send({ role: 'viewer', currentPassword: TEST_PASSWORD });

    expect(response.status).toBe(200);
    expect(response.body.account.role).toBe('viewer');
    expect(
      (
        await http()
          .post('/api/capabilities/rescan')
          .set('Cookie', await cookieFor('ops'))
      ).status,
    ).toBe(403);
  });

  /**
   * An install where nobody can manage accounts cannot be recovered from the
   * dashboard at all, and whoever is about to cause it is one click away.
   */
  it('refuses to demote the last account that can manage accounts', async () => {
    const boss = await cookieFor('boss');
    const listed = await http().get('/api/accounts').set('Cookie', boss);
    const admins = (listed.body.accounts as { id: string; role: string }[]).filter(
      (account) => account.role === 'admin',
    );

    // Demote every admin but the last, which must be refused.
    let refusals = 0;
    for (const admin of admins) {
      const response = await http()
        .post(`/api/accounts/${admin.id}/role`)
        .set('Cookie', boss)
        .send({ role: 'viewer', currentPassword: TEST_PASSWORD });
      if (response.status === 409) refusals += 1;
    }

    expect(refusals).toBeGreaterThan(0);
    const after = await http()
      .get('/api/accounts')
      .set('Cookie', await cookieFor('boss'));
    expect(
      (after.body.accounts as { role: string }[]).filter((a) => a.role === 'admin').length,
    ).toBeGreaterThanOrEqual(1);
  });

  it('refuses a role it does not know', async () => {
    const boss = await cookieFor('boss');
    const listed = await http().get('/api/accounts').set('Cookie', boss);
    const target = (listed.body.accounts as { id: string }[])[0];

    const response = await http()
      .post(`/api/accounts/${target?.id}/role`)
      .set('Cookie', boss)
      .send({ role: 'superuser', currentPassword: TEST_PASSWORD });

    expect(response.status).toBe(400);
  });

  it("refuses without the actor's own password", async () => {
    const boss = await cookieFor('boss');
    const listed = await http().get('/api/accounts').set('Cookie', boss);
    const target = (listed.body.accounts as { id: string; username: string }[]).find(
      (a) => a.username === 'guest',
    );

    const response = await http()
      .post(`/api/accounts/${target?.id}/role`)
      .set('Cookie', boss)
      .send({ role: 'admin', currentPassword: 'not the password' });

    expect(response.status).toBe(403);
  });
});
