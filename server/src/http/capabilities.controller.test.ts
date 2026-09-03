import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { IntegrationModule } from '../plugins/contract.js';
import { createTestApp, seedAccount, TEST_PASSWORD, type TestApp } from '../test/app-harness.js';
import { SESSION_COOKIE } from './cookies.js';

const traefik: IntegrationModule = {
  id: 'traefik',
  title: 'Traefik',
  scope: 'cluster',
  facets: ['http.access', 'http.routes'],
  requiredRbac: [{ apiGroups: ['apps'], resources: ['deployments'], verbs: ['get'] }],
  async detect({ probes }) {
    const workload = await probes.workload('Deployment', 'traefik', 'traefik');
    if (!workload) return { state: 'absent', evidence: 'No Deployment traefik/traefik' };

    return {
      state: 'present',
      evidence: 'Deployment traefik/traefik',
      ...(workload.version ? { version: workload.version } : {}),
    };
  },
  collectors: () => [],
  nav: [
    {
      id: 'traefik-routers',
      title: 'Traefik routers',
      category: 'network',
      href: '/integrations/traefik/routers',
      requiresFacet: 'http.routes',
    },
  ],
};

let harness: TestApp;
let cookie: string;

function http() {
  return request(harness.app.getHttpServer());
}

async function open(installed: boolean): Promise<void> {
  harness = await createTestApp({
    integrations: [traefik],
    cluster: installed
      ? {
          workloads: [
            {
              kind: 'Deployment',
              namespace: 'traefik',
              name: 'traefik',
              version: '41.4.0',
              readyReplicas: 1,
            },
          ],
        }
      : {},
  });
  await seedAccount(harness, 'admin');

  const response = await http()
    .post('/api/auth/login')
    .send({ username: 'admin', password: TEST_PASSWORD });
  const raw = response.headers['set-cookie'];
  const list = Array.isArray(raw) ? raw : [String(raw)];
  cookie = (list.find((value) => value.startsWith(`${SESSION_COOKIE}=`)) as string).split(
    ';',
  )[0] as string;

  await harness.detection.runOnce(Date.now());
}

afterEach(async () => {
  await harness.close();
});

describe('GET /api/capabilities', () => {
  beforeEach(async () => {
    await open(true);
  });

  it('reports a detected integration with its evidence', async () => {
    const response = await http().get('/api/capabilities').set('Cookie', cookie);

    expect(response.status).toBe(200);
    expect(response.body.integrations[0]).toMatchObject({
      id: 'traefik',
      state: 'present',
      version: '41.4.0',
      evidence: 'Deployment traefik/traefik',
      override: 'auto',
    });
  });

  it('enables the facets that integration feeds', async () => {
    const response = await http().get('/api/capabilities').set('Cookie', cookie);

    expect(response.body.facets['http.access']).toEqual({
      enabled: true,
      sources: ['traefik'],
    });
    expect(response.body.facets['http.routes'].enabled).toBe(true);
  });

  it('shows the screens those facets unlock', async () => {
    const response = await http().get('/api/capabilities').set('Cookie', cookie);
    const ids = response.body.nav.map((entry: { id: string }) => entry.id);

    expect(ids).toContain('http-traffic');
    expect(ids).toContain('routes');
  });

  it('includes the vendor page the integration unlocks', async () => {
    const response = await http().get('/api/capabilities').set('Cookie', cookie);

    expect(response.body.nav.map((entry: { id: string }) => entry.id)).toContain('traefik-routers');
  });

  it('requires a session', async () => {
    expect((await http().get('/api/capabilities')).status).toBe(401);
  });
});

describe('capabilities on a cluster without the integration', () => {
  beforeEach(async () => {
    await open(false);
  });

  /** Bare k3s must still get a usable sidebar, just a shorter one. */
  it('keeps core navigation and drops facet-dependent entries', async () => {
    const response = await http().get('/api/capabilities').set('Cookie', cookie);
    const ids = response.body.nav.map((entry: { id: string }) => entry.id);

    expect(ids).toContain('nodes');
    expect(ids).toContain('workloads');
    expect(ids).toContain('integrations');
    expect(ids).not.toContain('http-traffic');
    expect(ids).not.toContain('traefik-routers');
  });

  it('still lists the integration so the user can see it was looked for', async () => {
    const response = await http().get('/api/capabilities').set('Cookie', cookie);

    expect(response.body.integrations[0]).toMatchObject({
      id: 'traefik',
      state: 'absent',
      evidence: 'No Deployment traefik/traefik',
    });
  });

  it('turns the integration on when the user overrides detection', async () => {
    const override = await http()
      .post('/api/integrations/traefik/override')
      .set('Cookie', cookie)
      .send({ override: 'force_on' });
    expect(override.status).toBe(204);

    const response = await http().get('/api/capabilities').set('Cookie', cookie);
    expect(response.body.integrations[0].state).toBe('present');
    expect(response.body.nav.map((entry: { id: string }) => entry.id)).toContain('http-traffic');
  });

  it('rejects an override for an unknown integration', async () => {
    const response = await http()
      .post('/api/integrations/nope/override')
      .set('Cookie', cookie)
      .send({ override: 'force_on' });

    expect(response.status).toBe(404);
  });

  it('rejects an override that is not one of the three values', async () => {
    const response = await http()
      .post('/api/integrations/traefik/override')
      .set('Cookie', cookie)
      .send({ override: 'maybe' });

    expect(response.status).toBe(400);
  });

  it('re-probes on demand so a fresh install shows up without waiting', async () => {
    const response = await http().post('/api/capabilities/rescan').set('Cookie', cookie);

    expect(response.status).toBe(200);
    expect(response.body.integrations[0].state).toBe('absent');
  });
});
