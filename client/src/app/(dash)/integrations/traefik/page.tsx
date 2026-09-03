'use client';

import { type Column, FacetTable } from '@/components/facet-table';
import { Badge } from '@/components/ui/badge';
import { useManifest } from '@/lib/manifest-context';

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
    key: 'host',
    header: 'Host',
    render: (row) => (
      <span className="font-mono text-xs">
        {row.host}
        <span className="text-muted-foreground">{row.path}</span>
      </span>
    ),
  },
  {
    key: 'kind',
    header: 'Kind',
    render: (row) => (
      <Badge variant={row.kind === 'IngressRoute' ? 'secondary' : 'outline'}>{row.kind}</Badge>
    ),
  },
  {
    key: 'service',
    header: 'Service',
    render: (row) => (
      <span className="font-mono text-xs">
        {row.service}
        {row.port === null ? '' : `:${row.port}`}
      </span>
    ),
  },
  {
    key: 'tls',
    header: 'TLS',
    priority: 'md',
    render: (row) =>
      row.tls === 1 ? (
        <Badge variant="secondary">TLS</Badge>
      ) : (
        <Badge variant="outline">plain</Badge>
      ),
  },
  {
    key: 'namespace',
    header: 'Namespace',
    priority: 'md',
    render: (row) => <span className="font-mono text-xs">{row.namespace}</span>,
  },
  {
    key: 'name',
    header: 'Object',
    priority: 'lg',
    render: (row) => <span className="font-mono text-xs text-muted-foreground">{row.name}</span>,
  },
  {
    key: 'match',
    header: 'Match rule',
    priority: 'xl',
    // Traefik's own matcher expression, kept verbatim: it is the thing an
    // operator compares against their manifest when a route misbehaves.
    render: (row) => (
      <span className="font-mono text-xs text-muted-foreground">{row.attrs?.match ?? '—'}</span>
    ),
  },
];

export default function TraefikRoutersPage() {
  const { manifest } = useManifest();
  const traefik = manifest?.integrations.find((integration) => integration.id === 'traefik');

  return (
    <div className="screen gap-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h1 className="text-lg font-semibold tracking-tight">Traefik routers</h1>
        {traefik?.version && (
          <span className="font-mono text-xs text-muted-foreground">{traefik.version}</span>
        )}
        {traefik?.evidence && (
          <span className="font-mono text-xs text-muted-foreground">· {traefik.evidence}</span>
        )}
      </div>

      <FacetTable<TraefikRouteRow>
        facet="routes"
        columns={columns}
        fixed={{ integration: 'traefik' }}
        filters={[{ key: 'kind', label: 'Kinds', values: ['Ingress', 'IngressRoute'] }]}
        searchPlaceholder="Find a router by host, path or service"
        emptyMessage="Traefik is running, but no Ingress or IngressRoute has been collected yet."
      />
    </div>
  );
}
