'use client';

import { type Column, FacetTable } from '@/components/facet-table';
import { Badge } from '@/components/ui/badge';
import { formatBytes, formatDuration, formatTimestamp } from '@/lib/format';

interface AccessRow extends Record<string, unknown> {
  at: number;
  host: string;
  method: string;
  path: string;
  status: number;
  duration_ms: number;
  client_ip: string;
  route: string | null;
  bytes_out: number | null;
}

/** Status classes carry meaning, so they are the one place colour is severity. */
function statusTone(status: number): 'secondary' | 'outline' | 'destructive' {
  if (status >= 500) return 'destructive';
  if (status >= 400) return 'outline';
  return 'secondary';
}

const columns: Column<AccessRow>[] = [
  {
    key: 'at',
    header: 'When',
    render: (row) => <span className="font-mono text-xs">{formatTimestamp(row.at)}</span>,
  },
  {
    key: 'status',
    header: 'Status',
    render: (row) => <Badge variant={statusTone(row.status)}>{row.status}</Badge>,
  },
  {
    key: 'method',
    header: 'Method',
    render: (row) => <span className="font-mono text-xs">{row.method}</span>,
  },
  {
    key: 'path',
    header: 'Path',
    render: (row) => <span className="font-mono text-xs">{row.path}</span>,
  },
  {
    key: 'host',
    header: 'Host',
    priority: 'md',
    render: (row) => <span className="font-mono text-xs">{row.host}</span>,
  },
  {
    key: 'duration_ms',
    header: 'Took',
    priority: 'md',
    align: 'right',
    render: (row) => formatDuration(row.duration_ms),
  },
  {
    key: 'bytes_out',
    header: 'Sent',
    priority: 'lg',
    align: 'right',
    render: (row) => formatBytes(row.bytes_out),
  },
  {
    key: 'client_ip',
    header: 'Client',
    priority: 'xl',
    render: (row) => (
      <span className="font-mono text-xs text-muted-foreground">{row.client_ip}</span>
    ),
  },
  {
    key: 'route',
    header: 'Router',
    priority: 'xl',
    render: (row) => (
      <span className="font-mono text-xs text-muted-foreground">{row.route ?? '—'}</span>
    ),
  },
];

export default function HttpTrafficPage() {
  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <h1 className="text-lg font-semibold tracking-tight">HTTP traffic</h1>
      <FacetTable<AccessRow>
        facet="http-access"
        columns={columns}
        filters={[{ key: 'method', label: 'Methods', values: ['GET', 'POST', 'PUT', 'DELETE'] }]}
        searchPlaceholder="Find a request by path, host, client or router"
        emptyMessage="No request matches these filters."
      />
    </div>
  );
}
