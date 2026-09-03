import { describe, expect, it } from 'vitest';
import type { IngressInfo, KubeApi } from '../../kube/api.js';
import { describeIntegrationContract } from '../../plugins/conformance.js';
import { fakeProbes } from '../../test/fake-probes.js';
import { traefikIntegration } from './index.js';

const NOW = 1_756_800_000_000;

const ingress: IngressInfo = {
  namespace: 'kubitor',
  name: 'kubitor',
  className: 'traefik',
  tls: true,
  rules: [
    { host: 'kubitor.myuyayam.dev', path: '/', service: 'kubitor-client', port: 3000 },
    { host: 'kubitor.myuyayam.dev', path: '/api', service: 'kubitor-server', port: 3001 },
  ],
};

const ingressRoute = {
  metadata: { namespace: 'demo', name: 'demo-route' },
  spec: {
    tls: {},
    routes: [
      {
        match: 'Host(`demo.myuyayam.dev`) && PathPrefix(`/app`)',
        services: [{ name: 'demo-web', port: 8080 }],
      },
    ],
  },
};

function fakeApi(overrides: Partial<KubeApi> = {}): KubeApi {
  const unused = async () => {
    throw new Error('not used by these collectors');
  };

  return {
    serverVersion: async () => 'v1.36.3',
    listNodes: async () => [],
    listPods: async () => [],
    listNamespaces: async () => [],
    listEvents: async () => [],
    nodeSummary: unused,
    listIngresses: async () => [ingress],
    listCustomObjects: async () => [ingressRoute],
    podLogsSince: async () => [],
    hasCrd: async () => false,
    workload: async () => null,
    service: async () => false,
    serviceHasReadyEndpoints: async () => false,
    ingressClass: async () => false,
    storageClassProvisioners: async () => [],
    ...overrides,
  };
}

const deployed = {
  workloads: [
    {
      kind: 'Deployment',
      namespace: 'traefik',
      name: 'traefik',
      version: '41.4.0',
      readyReplicas: 1,
    },
  ],
};

describeIntegrationContract(traefikIntegration(fakeApi()), {
  present: deployed,
  absent: {},
  deniedProbes: ['workloads'],
});

describe('traefik detection', () => {
  it('reports the chart version it found', async () => {
    const detection = await traefikIntegration(fakeApi()).detect({
      probes: fakeProbes(deployed),
    });

    expect(detection.state).toBe('present');
    if (detection.state !== 'present') return;
    expect(detection.version).toBe('41.4.0');
    expect(detection.evidence).toBe('Deployment traefik/traefik');
  });

  /**
   * Installed but serving nothing. Showing empty graphs would read as "no
   * traffic"; the reason belongs on screen instead.
   */
  it('reports degraded when the deployment has no ready replicas', async () => {
    const detection = await traefikIntegration(fakeApi()).detect({
      probes: fakeProbes({
        workloads: [
          { kind: 'Deployment', namespace: 'traefik', name: 'traefik', readyReplicas: 0 },
        ],
      }),
    });

    expect(detection.state).toBe('present');
    if (detection.state !== 'present') return;
    expect(detection.degraded?.map((d) => d.facet).sort()).toEqual(['http.access', 'http.routes']);
  });

  it('accepts a CRD-only install with no deployment of that name', async () => {
    const detection = await traefikIntegration(fakeApi()).detect({
      probes: fakeProbes({ crds: ['ingressroutes.traefik.io'] }),
    });

    expect(detection.state).toBe('present');
    expect(detection.evidence).toContain('ingressroutes.traefik.io');
  });

  it('finds Traefik wherever the chart put it', async () => {
    const detection = await traefikIntegration(fakeApi()).detect({
      probes: fakeProbes({
        workloads: [
          { kind: 'Deployment', namespace: 'kube-system', name: 'traefik', readyReplicas: 1 },
        ],
      }),
    });

    expect(detection.evidence).toBe('Deployment kube-system/traefik');
  });
});

describe('traefik routes collector', () => {
  async function routes(api: KubeApi = fakeApi()): Promise<Record<string, unknown>[]> {
    const collector = traefikIntegration(api)
      .collectors()
      .find((c) => c.id === 'traefik-routes');
    if (collector?.kind !== 'poll') throw new Error('missing collector');

    const emissions = await collector.run({ probes: fakeProbes(), now: () => NOW });
    return emissions[0]?.rows as Record<string, unknown>[];
  }

  it('emits one row per ingress rule', async () => {
    const rows = await routes();
    const fromIngress = rows.filter((row) => row.kind === 'Ingress');

    expect(fromIngress).toHaveLength(2);
    expect(fromIngress[0]).toMatchObject({
      namespace: 'kubitor',
      host: 'kubitor.myuyayam.dev',
      path: '/',
      service: 'kubitor-client',
      port: 3000,
      tls: 1,
      class: 'traefik',
    });
  });

  it('pulls host and path out of an IngressRoute match rule', async () => {
    const row = (await routes()).find((entry) => entry.kind === 'IngressRoute');

    expect(row).toMatchObject({
      namespace: 'demo',
      host: 'demo.myuyayam.dev',
      path: '/app',
      service: 'demo-web',
      port: 8080,
      tls: 1,
    });
  });

  it('skips a malformed custom resource rather than losing the rest', async () => {
    const rows = await routes(
      fakeApi({ listCustomObjects: async () => [null, { spec: {} }, ingressRoute] }),
    );

    expect(rows.filter((row) => row.kind === 'IngressRoute')).toHaveLength(1);
  });

  it('emits an empty snapshot when nothing is routed, which clears stale rows', async () => {
    const rows = await routes(
      fakeApi({ listIngresses: async () => [], listCustomObjects: async () => [] }),
    );

    expect(rows).toEqual([]);
  });
});

describe('traefik access collector', () => {
  const line = JSON.stringify({
    RequestHost: 'kubitor.myuyayam.dev',
    RequestMethod: 'GET',
    RequestPath: '/',
    DownstreamStatus: 200,
    Duration: 1_000_000,
    ClientHost: '10.0.0.1',
    StartUTC: '2026-09-03T04:18:47Z',
  });

  async function access(api: KubeApi): Promise<Record<string, unknown>[]> {
    const collector = traefikIntegration(api)
      .collectors()
      .find((c) => c.id === 'traefik-access');
    if (collector?.kind !== 'poll') throw new Error('missing collector');

    const emissions = await collector.run({ probes: fakeProbes(), now: () => NOW });
    return emissions[0]?.rows as Record<string, unknown>[];
  }

  it('turns log lines into requests', async () => {
    const rows = await access(fakeApi({ podLogsSince: async () => [line, '', line] }));

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ host: 'kubitor.myuyayam.dev', status: 200 });
  });

  it('emits nothing when the log holds no requests', async () => {
    const rows = await access(
      fakeApi({ podLogsSince: async () => ['level=info msg="Configuration loaded"'] }),
    );

    expect(rows).toEqual([]);
  });
});
