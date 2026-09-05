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
    { host: 'kubitor.example.com', path: '/', service: 'kubitor-client', port: 3000 },
    { host: 'kubitor.example.com', path: '/api', service: 'kubitor-server', port: 3001 },
  ],
};

const ingressRoute = {
  metadata: { namespace: 'demo', name: 'demo-route' },
  spec: {
    tls: {},
    routes: [
      {
        match: 'Host(`demo.example.com`) && PathPrefix(`/app`)',
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
    podLogTails: async () => [],
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

  /**
   * A chart may be released under any name into any namespace, and an
   * Ingress-only install registers no CRD at all. The IngressClass it
   * registers is the same wherever it was put.
   */
  it('finds an install that matches neither a known name nor a CRD', async () => {
    const detection = await traefikIntegration(fakeApi()).detect({
      probes: fakeProbes({ ingressClasses: ['traefik'] }),
    });

    expect(detection.state).toBe('present');
    expect(detection.evidence).toBe('IngressClass traefik');
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
      host: 'kubitor.example.com',
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
      host: 'demo.example.com',
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
    RequestHost: 'kubitor.example.com',
    RequestMethod: 'GET',
    RequestPath: '/',
    DownstreamStatus: 200,
    Duration: 1_000_000,
    ClientHost: '10.0.0.1',
    StartUTC: '2026-09-03T04:18:47Z',
  });

  const other = (path: string): string =>
    JSON.stringify({
      RequestHost: 'kubitor.example.com',
      RequestMethod: 'GET',
      RequestPath: path,
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

  /**
   * The first poll is history: importing a tail on every restart would backdate
   * thousands of requests that were already recorded.
   */
  it('reads nothing on the first poll of a replica', async () => {
    const rows = await access(
      fakeApi({ podLogTails: async () => [{ pod: 'traefik-a', lines: [line, line] }] }),
    );

    expect(rows).toEqual([]);
  });

  it('reads only what arrived since the last poll', async () => {
    let tail = [line, other('/first')];
    const api = fakeApi({ podLogTails: async () => [{ pod: 'traefik-a', lines: tail }] });
    const integration = traefikIntegration(api);
    const collector = integration.collectors().find((c) => c.id === 'traefik-access');
    if (collector?.kind !== 'poll') throw new Error('missing collector');

    const run = async () => {
      const emissions = await collector.run({ probes: fakeProbes(), now: () => NOW });
      return emissions[0]?.rows as Record<string, unknown>[];
    };

    expect(await run()).toEqual([]);

    tail = [line, other('/first'), other('/second'), other('/third')];
    const second = await run();

    expect(second.map((row) => row.path)).toEqual(['/second', '/third']);
  });

  /** A burst can push the remembered line out of the tail entirely. */
  it('takes the whole tail when the last line it saw is gone', async () => {
    let tail = [other('/a')];
    const api = fakeApi({ podLogTails: async () => [{ pod: 'traefik-a', lines: tail }] });
    const collector = traefikIntegration(api)
      .collectors()
      .find((c) => c.id === 'traefik-access');
    if (collector?.kind !== 'poll') throw new Error('missing collector');

    await collector.run({ probes: fakeProbes(), now: () => NOW });

    tail = [other('/x'), other('/y')];
    const emissions = await collector.run({ probes: fakeProbes(), now: () => NOW });

    const paths = (emissions[0]?.rows ?? []).map((row) => (row as { path: string }).path);
    expect(paths).toEqual(['/x', '/y']);
  });

  it('tracks each replica separately', async () => {
    let tails = [
      { pod: 'a', lines: [other('/a1')] },
      { pod: 'b', lines: [other('/b1')] },
    ];
    const api = fakeApi({ podLogTails: async () => tails });
    const collector = traefikIntegration(api)
      .collectors()
      .find((c) => c.id === 'traefik-access');
    if (collector?.kind !== 'poll') throw new Error('missing collector');

    await collector.run({ probes: fakeProbes(), now: () => NOW });

    tails = [
      { pod: 'a', lines: [other('/a1'), other('/a2')] },
      { pod: 'b', lines: [other('/b1')] },
    ];
    const emissions = await collector.run({ probes: fakeProbes(), now: () => NOW });

    const paths = (emissions[0]?.rows ?? []).map((row) => (row as { path: string }).path);
    expect(paths).toEqual(['/a2']);
  });

  it('skips a line that is not a request', async () => {
    let tail = [other('/seed')];
    const api = fakeApi({ podLogTails: async () => [{ pod: 'a', lines: tail }] });
    const collector = traefikIntegration(api)
      .collectors()
      .find((c) => c.id === 'traefik-access');
    if (collector?.kind !== 'poll') throw new Error('missing collector');

    await collector.run({ probes: fakeProbes(), now: () => NOW });

    tail = [other('/seed'), 'level=info msg="Configuration loaded"'];
    const emissions = await collector.run({ probes: fakeProbes(), now: () => NOW });

    expect(emissions[0]?.rows).toEqual([]);
  });

  /**
   * Addresses live on the Routes screen whichever ingress publishes them. A
   * second list of the same rows meant an operator had to know which ingress
   * their cluster ran before they could find one; what Traefik knows that the
   * neutral shape does not travels in `attrs` and becomes a column there.
   */
  it('adds no navigation of its own', () => {
    expect(traefikIntegration(fakeApi()).nav).toEqual([]);
  });
});
