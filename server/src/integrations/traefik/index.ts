import type { IngressInfo, KubeApi } from '../../kube/api.js';
import type { Collector, Emission, IntegrationModule } from '../../plugins/contract.js';
import { parseAccessLine } from './access-log.js';

const NAMESPACE_CANDIDATES = ['traefik', 'kube-system', 'traefik-system'];
const ROUTES_INTERVAL_MS = 30_000;
const ACCESS_INTERVAL_MS = 15_000;
/**
 * Overlap the log window slightly so a poll that lands late does not leave a
 * gap. Duplicates are cheap; a missing request is not recoverable.
 */
const ACCESS_WINDOW_SECONDS = Math.ceil((ACCESS_INTERVAL_MS / 1000) * 1.5);

export function traefikIntegration(api: KubeApi): IntegrationModule {
  return {
    id: 'traefik',
    title: 'Traefik',
    scope: 'cluster',
    facets: ['http.routes', 'http.access'],
    requiredRbac: [
      { apiGroups: ['apps'], resources: ['deployments'], verbs: ['get'] },
      { apiGroups: ['networking.k8s.io'], resources: ['ingresses'], verbs: ['list'] },
      { apiGroups: ['traefik.io'], resources: ['ingressroutes'], verbs: ['list'] },
      { apiGroups: [''], resources: ['pods', 'pods/log'], verbs: ['get', 'list'] },
    ],

    async detect({ probes }) {
      for (const namespace of NAMESPACE_CANDIDATES) {
        const deployment = await probes.workload('Deployment', namespace, 'traefik');
        if (!deployment) continue;

        const evidence = `Deployment ${namespace}/traefik`;

        // Installed but serving nothing: the routes it publishes are stale and
        // no request is reaching it, so say so rather than showing empty graphs.
        if (deployment.readyReplicas === 0) {
          return {
            state: 'present',
            evidence,
            ...(deployment.version ? { version: deployment.version } : {}),
            degraded: [
              { facet: 'http.access', reason: 'Traefik has no ready replicas' },
              { facet: 'http.routes', reason: 'Traefik has no ready replicas' },
            ],
          };
        }

        return {
          state: 'present',
          evidence,
          ...(deployment.version ? { version: deployment.version } : {}),
        };
      }

      if (await probes.hasCrd('ingressroutes.traefik.io')) {
        return { state: 'present', evidence: 'CustomResourceDefinition ingressroutes.traefik.io' };
      }

      return {
        state: 'absent',
        evidence: `No Traefik deployment in ${NAMESPACE_CANDIDATES.join(', ')}`,
      };
    },

    collectors(): readonly Collector[] {
      return [
        {
          kind: 'poll',
          id: 'traefik-routes',
          intervalMs: ROUTES_INTERVAL_MS,
          async run(ctx): Promise<Emission[]> {
            const observedAt = ctx.now();
            const ingresses = await api.listIngresses();
            const ingressRoutes = await api.listCustomObjects(
              'traefik.io',
              'v1alpha1',
              'ingressroutes',
            );

            return [
              {
                facet: 'http.routes',
                rows: [
                  ...ingresses.flatMap((ingress) => fromIngress(ingress, observedAt)),
                  ...ingressRoutes.flatMap((route) => fromIngressRoute(route, observedAt)),
                ],
              },
            ];
          },
        },

        {
          kind: 'poll',
          id: 'traefik-access',
          intervalMs: ACCESS_INTERVAL_MS,
          async run(): Promise<Emission[]> {
            const rows: Record<string, unknown>[] = [];

            for (const namespace of NAMESPACE_CANDIDATES) {
              const lines = await api.podLogsSince(
                namespace,
                'app.kubernetes.io/name=traefik',
                ACCESS_WINDOW_SECONDS,
              );
              if (lines.length === 0) continue;

              for (const line of lines) {
                const parsed = parseAccessLine(line);
                if (parsed) rows.push(parsed as unknown as Record<string, unknown>);
              }
              break;
            }

            return [{ facet: 'http.access', rows }];
          },
        },
      ];
    },

    nav: [
      {
        id: 'traefik-routers',
        title: 'Traefik routers',
        category: 'network',
        href: '/integrations/traefik',
        requiresFacet: 'http.routes',
        order: 10,
      },
    ],
  };
}

function fromIngress(ingress: IngressInfo, observedAt: number): Record<string, unknown>[] {
  return ingress.rules.map((rule) => ({
    observed_at: observedAt,
    kind: 'Ingress',
    namespace: ingress.namespace,
    name: ingress.name,
    host: rule.host,
    path: rule.path,
    service: rule.service,
    port: rule.port,
    tls: ingress.tls ? 1 : 0,
    class: ingress.className,
    attrs: {},
  }));
}

/**
 * IngressRoute is a custom resource, so it arrives as untyped JSON. Anything
 * unexpected is skipped rather than throwing: one malformed route must not cost
 * the screen every other route.
 */
function fromIngressRoute(route: unknown, observedAt: number): Record<string, unknown>[] {
  if (typeof route !== 'object' || route === null) return [];

  const document = route as {
    metadata?: { namespace?: string; name?: string };
    spec?: {
      routes?: { match?: string; services?: { name?: string; port?: number }[] }[];
      tls?: unknown;
    };
  };

  const namespace = document.metadata?.namespace;
  const name = document.metadata?.name;
  if (!namespace || !name) return [];

  return (document.spec?.routes ?? []).map((entry) => ({
    observed_at: observedAt,
    kind: 'IngressRoute',
    namespace,
    name,
    host: hostFromMatch(entry.match) ?? '*',
    path: pathFromMatch(entry.match) ?? '/',
    service: entry.services?.[0]?.name ?? '',
    port: entry.services?.[0]?.port ?? null,
    tls: document.spec?.tls ? 1 : 0,
    class: null,
    attrs: { match: entry.match ?? null },
  }));
}

/** Traefik match rules look like: Host(`a.example`) && PathPrefix(`/api`) */
function hostFromMatch(match: string | undefined): string | null {
  return capture(match, /Host\(`([^`]+)`\)/);
}

function pathFromMatch(match: string | undefined): string | null {
  return capture(match, /PathPrefix\(`([^`]+)`\)/) ?? capture(match, /Path\(`([^`]+)`\)/);
}

function capture(value: string | undefined, pattern: RegExp): string | null {
  if (!value) return null;
  return pattern.exec(value)?.[1] ?? null;
}
