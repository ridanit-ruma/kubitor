'use client';

import { type Column, FacetTable } from '@/components/facet-table';
import { Badge } from '@/components/ui/badge';
import { useManifest } from '@/lib/manifest-context';
import { encodeRouteId } from '@/lib/route-id';

interface TraefikRouteRow extends Record<string, unknown> {
  kind: string;
  namespace: string;
  name: string;
  host: string;
  path: string;
  service: string;
  port: number | null;
  tls: number;
  attrs: { match?: string | null };
}

const columns: Column<TraefikRouteRow>[] = [
  {
    key: 'name',
    header: 'Router',
    width: 'w-[26%]',
    render: (row) => (
      <span className="font-mono text-xs">
        {row.name}
        <span className="text-muted-foreground"> · {row.namespace}</span>
      </span>
    ),
  },
  {
    key: 'match',
    header: 'Match rule',
    width: 'w-[38%]',
    // Traefik's own matcher expression, verbatim. This is the string an
    // operator compares against their manifest when a route misbehaves, and the
    // reason this screen exists next to the vendor-neutral Routes list.
    render: (row) => (
      <span className="font-mono text-xs">
        {row.attrs?.match ?? (
          <span className="text-muted-foreground">
            Host(`{row.host}`)
            {row.path && row.path !== '/' ? ` && PathPrefix(\`${row.path}\`)` : ''}
          </span>
        )}
      </span>
    ),
  },
  {
    key: 'kind',
    header: 'Declared as',
    width: 'w-[16%]',
    render: (row) => (
      <Badge variant={row.kind === 'IngressRoute' ? 'secondary' : 'outline'}>{row.kind}</Badge>
    ),
  },
  {
    key: 'service',
    header: 'Service',
    width: 'w-[20%]',
    priority: 'md',
    render: (row) => (
      <span className="font-mono text-xs">
        {row.service}
        {row.port === null ? '' : `:${row.port}`}
      </span>
    ),
  },
];

/**
 * Traefik's own model of what it is routing.
 *
 * Deliberately not a second copy of the Routes list. Routes answers "what
 * address does this cluster answer on", the same way whichever ingress is
 * installed; this answers "what has Traefik been told", in Traefik's own terms —
 * router names and matcher expressions, which is what an operator compares
 * against a manifest when an address does not behave.
 */
export default function TraefikRoutersPage() {
  const { manifest } = useManifest();
  const traefik = manifest?.integrations.find((integration) => integration.id === 'traefik');

  return (
    <div className="screen gap-3">
      <div>
        <div className="flex flex-wrap items-baseline gap-x-3">
          <h1 className="text-lg font-semibold tracking-tight">Traefik routers</h1>
          {traefik?.version && (
            <span className="font-mono text-xs text-muted-foreground">{traefik.version}</span>
          )}
        </div>
        <p className="text-sm text-muted-foreground">
          Traefik&rsquo;s own matcher rules. For the cluster&rsquo;s addresses regardless of
          ingress, see Routes.
        </p>
      </div>

      <FacetTable<TraefikRouteRow>
        facet="routes"
        columns={columns}
        fixed={{ integration: 'traefik' }}
        filters={[{ key: 'kind', label: 'Kinds', values: ['Ingress', 'IngressRoute'] }]}
        searchPlaceholder="Find a router by name, host or service"
        emptyMessage="Traefik is running, but no Ingress or IngressRoute has been collected yet."
        onRowHref={(row) =>
          `/routes/${encodeRouteId({
            kind: row.kind,
            namespace: row.namespace,
            name: row.name,
            host: row.host,
            path: row.path,
          })}`
        }
      />
    </div>
  );
}
