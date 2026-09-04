'use client';

import { type Column, FacetTable } from '@/components/facet-table';
import { Badge } from '@/components/ui/badge';
import { encodeRouteId } from '@/lib/route-id';

interface RouteRow extends Record<string, unknown> {
  kind: string;
  namespace: string;
  name: string;
  host: string;
  path: string;
  service: string;
  port: number | null;
  tls: number;
  class: string | null;
  integration: string;
}

const columns: Column<RouteRow>[] = [
  {
    key: 'host',
    header: 'Address',
    width: 'w-[34%]',
    render: (row) => (
      <span className="font-mono text-xs">
        {row.host}
        <span className="text-muted-foreground">{row.path}</span>
      </span>
    ),
  },
  {
    key: 'service',
    header: 'Backend',
    width: 'w-[24%]',
    priority: 'sm',
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
    width: 'w-[22%] sm:w-[10%]',
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
    width: 'w-[16%]',
    priority: 'md',
    render: (row) => <span className="font-mono text-xs">{row.namespace}</span>,
  },
  {
    key: 'integration',
    header: 'Served by',
    width: 'w-[16%]',
    priority: 'lg',
    render: (row) => (
      <span className="font-mono text-xs text-muted-foreground">
        {row.integration} · {row.kind}
      </span>
    ),
  },
];

/**
 * Every address the cluster answers on, whoever publishes it.
 *
 * The vendor-neutral index: one row per address, naming the integration that
 * reported it. A vendor's own screen — Traefik routers, say — is where its
 * particular concepts live, and this list is deliberately the part that looks
 * the same whichever ingress you run.
 */
export default function RoutesPage() {
  return (
    <div className="screen gap-3">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Routes</h1>
        <p className="text-sm text-muted-foreground">
          Every address the cluster answers on. Open one to see its definition and the requests it
          has served.
        </p>
      </div>
      <FacetTable<RouteRow>
        facet="routes"
        columns={columns}
        filters={[{ key: 'kind', label: 'Kinds', values: ['Ingress', 'IngressRoute'] }]}
        searchPlaceholder="Find a route by host, path or service"
        excludable
        excludePlaceholder="Hide routes matching…"
        emptyMessage="Nothing is routed here yet."
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
