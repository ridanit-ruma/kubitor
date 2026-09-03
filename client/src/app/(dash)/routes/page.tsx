'use client';

import { type Column, FacetTable } from '@/components/facet-table';
import { Badge } from '@/components/ui/badge';

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
    header: 'Host',
    render: (row) => (
      <span className="font-mono text-xs">
        {row.host}
        <span className="text-muted-foreground">{row.path}</span>
      </span>
    ),
  },
  {
    key: 'tls',
    header: 'TLS',
    render: (row) =>
      row.tls === 1 ? (
        <Badge variant="secondary">TLS</Badge>
      ) : (
        <Badge variant="outline">plain</Badge>
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
    key: 'namespace',
    header: 'Namespace',
    priority: 'md',
    render: (row) => <span className="font-mono text-xs">{row.namespace}</span>,
  },
  { key: 'kind', header: 'Kind', priority: 'lg', render: (row) => row.kind },
  {
    key: 'name',
    header: 'Object',
    priority: 'xl',
    render: (row) => <span className="font-mono text-xs text-muted-foreground">{row.name}</span>,
  },
  {
    key: 'integration',
    header: 'Source',
    priority: 'xl',
    render: (row) => (
      <span className="font-mono text-xs text-muted-foreground">{row.integration}</span>
    ),
  },
];

export default function RoutesPage() {
  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <h1 className="text-lg font-semibold tracking-tight">Routes</h1>
      <FacetTable<RouteRow>
        facet="routes"
        columns={columns}
        filters={[{ key: 'kind', label: 'Kinds', values: ['Ingress', 'IngressRoute'] }]}
        searchPlaceholder="Find a route by host, path or service"
        emptyMessage="Nothing is routed here yet."
      />
    </div>
  );
}
