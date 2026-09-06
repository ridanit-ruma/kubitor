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

async function issue(name: string, password = TEST_PASSWORD): Promise<request.Response> {
  return http()
    .post('/api/agents')
    .set('Cookie', adminCookie)
    .send({ name, currentPassword: password });
}

beforeEach(async () => {
  harness = await createTestApp({ nodeNames: ['ken', 'calder'] });
  await seedAccount(harness, 'admin');
  adminCookie = await loginCookie('admin');
});

afterEach(async () => {
  await harness.close();
});

describe('GET /api/agents', () => {
  it('lists nothing on a fresh install', async () => {
    const response = await http().get('/api/agents').set('Cookie', adminCookie);

    expect(response.status).toBe(200);
    expect(response.body.agents).toEqual([]);
  });

  it('rejects an anonymous caller', async () => {
    expect((await http().get('/api/agents')).status).toBe(401);
  });

  it('marks a credential whose name is also a cluster node', async () => {
    await issue('ken');

    const response = await http().get('/api/agents').set('Cookie', adminCookie);
    expect(response.body.agents[0]).toMatchObject({ name: 'ken', isNode: true });
  });
});

describe('POST /api/agents', () => {
  it('issues a token and never returns it again', async () => {
    const response = await issue('buildbox');

    expect(response.status).toBe(201);
    expect(response.body.token).toEqual(expect.any(String));

    const listed = await http().get('/api/agents').set('Cookie', adminCookie);
    expect(JSON.stringify(listed.body)).not.toContain(response.body.token);
  });

  it('refuses a wrong password and issues nothing', async () => {
    expect((await issue('buildbox', 'not the password')).status).toBe(403);

    const listed = await http().get('/api/agents').set('Cookie', adminCookie);
    expect(listed.body.agents).toEqual([]);
  });

  it('refuses a name that is not a plausible host name', async () => {
    expect((await issue('Build Box!')).status).toBe(400);
  });
});

/**
 * The whole loop, because each half is worthless alone: a token the dashboard
 * mints has to be one the ingest endpoint accepts, and revoking it has to
 * actually stop the machine reporting.
 */
describe('an issued token as a credential', () => {
  const reading = {
    rows: [{ at: 1_756_800_000_000, node: 'buildbox', cpu_percent: 12 }],
  };

  it('reports host readings, and stops the moment it is revoked', async () => {
    const token = (await issue('buildbox')).body.token as string;

    const accepted = await http()
      .post('/api/ingest/host')
      .set('Authorization', `Bearer ${token}`)
      .send(reading);
    expect(accepted.status).toBe(202);

    const revoked = await http()
      .post('/api/agents/buildbox/revoke')
      .set('Cookie', adminCookie)
      .send({ currentPassword: TEST_PASSWORD });
    expect(revoked.status).toBe(204);

    const refused = await http()
      .post('/api/ingest/host')
      .set('Authorization', `Bearer ${token}`)
      .send(reading);
    expect(refused.status).toBe(401);
  });

  /** A row claiming another machine is rewritten to the credential's own name. */
  it("cannot report on another machine's behalf", async () => {
    const token = (await issue('buildbox')).body.token as string;

    await http()
      .post('/api/ingest/host')
      .set('Authorization', `Bearer ${token}`)
      .send({ rows: [{ at: 1_756_800_000_000, node: 'ken', cpu_percent: 99 }] });

    const rows = await harness.db.selectFrom('facet_host_resources').selectAll().execute();
    expect(rows.map((row) => row.node)).not.toContain('ken');
  });
});

describe('POST /api/agents/:name/revoke', () => {
  it('refuses a wrong password and keeps the credential', async () => {
    await issue('buildbox');

    const response = await http()
      .post('/api/agents/buildbox/revoke')
      .set('Cookie', adminCookie)
      .send({ currentPassword: 'not the password' });

    expect(response.status).toBe(403);
    const listed = await http().get('/api/agents').set('Cookie', adminCookie);
    expect(listed.body.agents).toHaveLength(1);
  });

  it('reports a name it does not know', async () => {
    const response = await http()
      .post('/api/agents/nowhere/revoke')
      .set('Cookie', adminCookie)
      .send({ currentPassword: TEST_PASSWORD });

    expect(response.status).toBe(404);
  });
});
