import { SECRET_KEPT } from '@kubitor/shared';
import { generateIdentity } from 'age-encryption';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, seedAccount, TEST_PASSWORD, type TestApp } from '../test/app-harness.js';
import { SESSION_COOKIE } from './cookies.js';

let harness: TestApp;
let adminCookie: string;

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

/** The body `GET` returns, ready to send back as a `PUT`. */
async function currentNotify(): Promise<Record<string, unknown>> {
  const response = await http().get('/api/settings/notify').set('Cookie', adminCookie);
  const { canStoreSecrets: _ignored, ...input } = response.body;
  return input;
}

beforeEach(async () => {
  harness = await createTestApp({ config: { settingsKey: await generateIdentity() } });
  await seedAccount(harness, 'admin');
  await seedAccount(harness, 'ops', false, 'operator');
  await seedAccount(harness, 'guest', false, 'viewer');
  adminCookie = await cookieFor('admin');
});

afterEach(async () => {
  await harness.close();
});

describe('GET /api/settings/notify', () => {
  it('shows every channel, unconfigured, on a fresh install', async () => {
    const response = await http().get('/api/settings/notify').set('Cookie', adminCookie);

    expect(response.status).toBe(200);
    expect(response.body.discord).toEqual({ webhookUrl: null });
    expect(response.body.minimumSeverity).toBe('warning');
    expect(response.body.canStoreSecrets).toBe(true);
  });

  it('rejects an anonymous caller', async () => {
    expect((await http().get('/api/settings/notify')).status).toBe(401);
  });
});

describe('PUT /api/settings/notify', () => {
  it('stores a webhook and never hands it back', async () => {
    const saved = await http()
      .put('/api/settings/notify')
      .set('Cookie', adminCookie)
      .send({
        ...(await currentNotify()),
        discord: { webhookUrl: 'https://discord.com/api/webhooks/1/hunter2' },
      });

    expect(saved.status).toBe(200);
    expect(saved.body.changed).toEqual(['discord.webhookUrl']);

    const read = await http().get('/api/settings/notify').set('Cookie', adminCookie);
    expect(read.body.discord.webhookUrl).toBe(SECRET_KEPT);
    expect(JSON.stringify(read.body)).not.toContain('hunter2');
  });

  /**
   * The invariant the redaction rests on. If saving an untouched form could
   * erase a webhook, nobody would ever open the form.
   */
  it('changes nothing when the body it returned is sent straight back', async () => {
    await http()
      .put('/api/settings/notify')
      .set('Cookie', adminCookie)
      .send({
        ...(await currentNotify()),
        slack: { webhookUrl: 'https://hooks.slack.com/services/x' },
      });

    const again = await http()
      .put('/api/settings/notify')
      .set('Cookie', adminCookie)
      .send(await currentNotify());

    expect(again.body.changed).toEqual([]);
    expect(harness.settings.notify.slackWebhook).toBe('https://hooks.slack.com/services/x');
  });

  /**
   * The whole point: a channel added from the dashboard is delivering before
   * anybody restarts anything.
   */
  it('is in force without a restart', async () => {
    expect(
      (await http().get('/api/alerts').set('Cookie', adminCookie)).body.delivery.configured,
    ).toBe(false);

    await http()
      .put('/api/settings/notify')
      .set('Cookie', adminCookie)
      .send({
        ...(await currentNotify()),
        discord: { webhookUrl: 'https://discord.com/api/webhooks/1/abc' },
      });

    expect(
      (await http().get('/api/alerts').set('Cookie', adminCookie)).body.delivery.configured,
    ).toBe(true);
  });

  it('refuses half a channel, and names the field that is missing', async () => {
    const response = await http()
      .put('/api/settings/notify')
      .set('Cookie', adminCookie)
      .send({ ...(await currentNotify()), telegram: { token: null, chatId: '4242' } });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('invalid_settings');
    expect(response.body.field).toContain('telegram');
  });

  it('refuses a body that is not a settings document at all', async () => {
    const response = await http()
      .put('/api/settings/notify')
      .set('Cookie', adminCookie)
      .send({ minimumSeverity: 'warning' });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('invalid_body');
  });

  it('records who changed which field, and never the value', async () => {
    await http()
      .put('/api/settings/notify')
      .set('Cookie', adminCookie)
      .send({
        ...(await currentNotify()),
        discord: { webhookUrl: 'https://discord.com/api/webhooks/1/hunter2' },
      });

    const rows = await harness.db
      .selectFrom('account_events')
      .selectAll()
      .where('action', '=', 'settings_change')
      .execute();

    expect(rows).toHaveLength(1);
    expect(rows[0]?.subject).toBe('notify');
    expect(rows[0]?.detail).toContain('discord.webhookUrl');
    expect(rows[0]?.detail).not.toContain('hunter2');
  });

  it('writes no audit row when nothing changed', async () => {
    await http()
      .put('/api/settings/notify')
      .set('Cookie', adminCookie)
      .send(await currentNotify());

    const rows = await harness.db
      .selectFrom('account_events')
      .selectAll()
      .where('action', '=', 'settings_change')
      .execute();

    expect(rows).toEqual([]);
  });
});

describe('with no KUBITOR_SETTINGS_KEY', () => {
  beforeEach(async () => {
    await harness.close();
    harness = await createTestApp();
    await seedAccount(harness, 'admin');
    adminCookie = await cookieFor('admin');
  });

  it('says a secret cannot be stored before anybody types one', async () => {
    const response = await http().get('/api/settings/notify').set('Cookie', adminCookie);

    expect(response.body.canStoreSecrets).toBe(false);
  });

  it('refuses to store one rather than storing it in the clear', async () => {
    const response = await http()
      .put('/api/settings/notify')
      .set('Cookie', adminCookie)
      .send({
        ...(await currentNotify()),
        discord: { webhookUrl: 'https://discord.com/api/webhooks/1/abc' },
      });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('settings_key_missing');
  });

  it('still lets the severity floor be changed', async () => {
    const response = await http()
      .put('/api/settings/notify')
      .set('Cookie', adminCookie)
      .send({ ...(await currentNotify()), minimumSeverity: 'critical' });

    expect(response.status).toBe(200);
    expect(response.body.changed).toEqual(['minimumSeverity']);
  });
});

describe('POST /api/settings/notify/test', () => {
  it('reports a channel that is not configured rather than pretending it sent', async () => {
    const response = await http()
      .post('/api/settings/notify/test')
      .set('Cookie', adminCookie)
      .send({ channel: 'discord' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: false, error: expect.stringContaining('not configured') });
  });

  it('refuses a channel name it does not have a body for', async () => {
    const response = await http()
      .post('/api/settings/notify/test')
      .set('Cookie', adminCookie)
      .send({});

    expect(response.status).toBe(400);
  });
});

describe('the backup document', () => {
  const destination = {
    schedule: '5 4 * * *',
    ageRecipient: '',
    destination: {
      endpoint: 'https://s3.example.com',
      bucket: 'kubitor-backups',
      prefix: '',
      region: 'eu-central-1',
      accessKey: 'AKIA',
      secretKey: 's3cr3t',
    },
  };

  it('never returns the secret key', async () => {
    await http()
      .put('/api/settings/backup')
      .set('Cookie', adminCookie)
      .send({ ...destination, currentPassword: TEST_PASSWORD });

    const read = await http().get('/api/settings/backup').set('Cookie', adminCookie);

    expect(read.body.destination.secretKey).toBe(SECRET_KEPT);
    expect(JSON.stringify(read.body)).not.toContain('s3cr3t');
  });

  /**
   * The same bar `POST /api/backups/run` already sets on the same credentials.
   * Changing where backups go is not less sensitive than running one.
   */
  it('refuses a wrong password and stores nothing', async () => {
    const response = await http()
      .put('/api/settings/backup')
      .set('Cookie', adminCookie)
      .send({ ...destination, currentPassword: 'not the password' });

    expect(response.status).toBe(403);
    expect(response.body.error).toBe('reauthentication_failed');
    expect(harness.settings.backup).toBeNull();
  });

  it('turns backups on for the routes that were dark without them', async () => {
    await http()
      .put('/api/settings/backup')
      .set('Cookie', adminCookie)
      .send({ ...destination, currentPassword: TEST_PASSWORD });

    expect(harness.settings.backup).toMatchObject({ bucket: 'kubitor-backups' });
  });

  it('refuses a schedule that is not a cron expression', async () => {
    const response = await http()
      .put('/api/settings/backup')
      .set('Cookie', adminCookie)
      .send({ ...destination, schedule: 'every tuesday', currentPassword: TEST_PASSWORD });

    expect(response.status).toBe(400);
    expect(response.body.field).toBe('schedule');
  });
});

/**
 * The client hides what a role cannot reach, and that is a courtesy. These are
 * the control.
 */
describe('what the other roles cannot do', () => {
  it.each([
    ['ops', '/api/settings/notify'],
    ['ops', '/api/settings/backup'],
    ['guest', '/api/settings/notify'],
    ['guest', '/api/settings/backup'],
  ])('refuses %s a GET of %s', async (username, path) => {
    const response = await http()
      .get(path)
      .set('Cookie', await cookieFor(username));

    expect(response.status).toBe(403);
    expect(response.body.error).toBe('forbidden');
  });

  it('refuses an operator a test send', async () => {
    const response = await http()
      .post('/api/settings/notify/test')
      .set('Cookie', await cookieFor('ops'))
      .send({ channel: 'discord' });

    expect(response.status).toBe(403);
  });
});
