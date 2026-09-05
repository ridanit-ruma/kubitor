import type { IngressInfo, KubeApi } from '../../kube/api.js';
import type { Collector, Emission, IntegrationModule } from '../../plugins/contract.js';
import { parseAccessLine } from './access-log.js';

const NAMESPACE_CANDIDATES = ['traefik', 'kube-system', 'traefik-system'];
const ROUTES_INTERVAL_MS = 30_000;
const ACCESS_INTERVAL_MS = 15_000;
/**
 * How much of each replica's log to re-read every poll.
 *
 * Generous on purpose: the reader resumes from the last line it saw, so the
 * only cost of a large tail is parsing, while too small a tail loses requests
 * during a burst. At this size a replica can serve ~130 requests a second
 * between polls before anything is missed.
 */
const ACCESS_TAIL_LINES = 2000;

export function traefikIntegration(api: KubeApi): IntegrationModule {
  /*
   * The last line already read from each replica.
   *
   * Resuming from a remembered line rather than a timestamp keeps two requests
   * in the same millisecond, survives a restart without replaying the log, and
   * does not depend on `sinceSeconds`, which the client accepts and silently
   * ignores.
   */
  const lastLineByPod = new Map<string, string>();

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

      // Neither of these depends on where Traefik was installed or what the
      // release was called. A chart may be named anything and go anywhere; the
      // CRD and the IngressClass it registers are the same everywhere.
      if (await probes.hasCrd('ingressroutes.traefik.io')) {
        return { state: 'present', evidence: 'CustomResourceDefinition ingressroutes.traefik.io' };
      }

      if (await probes.ingressClass('traefik')) {
        return { state: 'present', evidence: 'IngressClass traefik' };
      }

      return {
        state: 'absent',
        evidence: `No Traefik deployment in ${NAMESPACE_CANDIDATES.join(', ')}, and no traefik IngressClass or IngressRoute CRD`,
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
              const tails = await api.podLogTails(
                namespace,
                'app.kubernetes.io/name=traefik',
                ACCESS_TAIL_LINES,
              );
              if (tails.length === 0) continue;

              for (const tail of tails) {
                for (const line of unreadLines(tail.lines, lastLineByPod.get(tail.pod))) {
                  const parsed = parseAccessLine(line);
                  if (parsed) rows.push(parsed as unknown as Record<string, unknown>);
                }

                const newest = tail.lines.at(-1);
                if (newest !== undefined) lastLineByPod.set(tail.pod, newest);
              }
              break;
            }

            return [{ facet: 'http.access', rows }];
          },
        },
      ];
    },

    /**
     * No screen of its own.
     *
     * Traefik publishes addresses, and the Routes screen is where addresses
     * live whichever ingress publishes them. A second list of the same rows
     * meant an operator had to know which ingress their cluster ran before they
     * could find one. What Traefik knows that the neutral shape does not — its
     * matcher expression — travels in `attrs` and becomes a column on that
     * screen wherever Traefik is feeding it.
     */
    nav: [],
  };
}

/**
 * Everything after the last line already read.
 *
 * The first poll of a replica yields nothing: the tail is history, and importing
 * it would backdate thousands of requests on every restart. From then on, a line
 * that has fallen out of the tail — a burst, or a rotated log — means the whole
 * tail is taken, because re-reading a few requests is recoverable and skipping
 * them is not.
 */
function unreadLines(lines: readonly string[], lastSeen: string | undefined): string[] {
  if (lastSeen === undefined) return [];
  const index = lines.lastIndexOf(lastSeen);
  return index === -1 ? [...lines] : lines.slice(index + 1);
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
