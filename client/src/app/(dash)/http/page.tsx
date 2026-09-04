'use client';

import { useEffect, useState } from 'react';
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
    width: 'w-[26%] sm:w-[15%]',
    render: (row) => <span className="font-mono text-xs">{formatTimestamp(row.at)}</span>,
  },
  {
    key: 'status',
    header: 'Status',
    width: 'w-[16%] sm:w-[9%]',
    render: (row) => <Badge variant={statusTone(row.status)}>{row.status}</Badge>,
  },
  {
    key: 'method',
    header: 'Method',
    width: 'w-[9%]',
    priority: 'sm',
    render: (row) => <span className="font-mono text-xs">{row.method}</span>,
  },
  {
    key: 'path',
    header: 'Path',
    width: 'w-[27%]',
    render: (row) => <span className="font-mono text-xs">{row.path}</span>,
  },
  {
    key: 'host',
    header: 'Host',
    width: 'w-[18%]',
    priority: 'md',
    render: (row) => <span className="font-mono text-xs">{row.host}</span>,
  },
  {
    key: 'duration_ms',
    header: 'Took',
    width: 'w-[10%]',
    priority: 'md',
    align: 'right',
    render: (row) => formatDuration(row.duration_ms),
  },
  {
    key: 'bytes_out',
    header: 'Sent',
    width: 'w-[8%]',
    priority: 'lg',
    align: 'right',
    render: (row) => formatBytes(row.bytes_out),
  },
  {
    key: 'client_ip',
    header: 'Client',
    width: 'w-[14%]',
    priority: 'xl',
    render: (row) => (
      <span className="font-mono text-xs text-muted-foreground">{row.client_ip}</span>
    ),
  },
  {
    key: 'route',
    header: 'Router',
    width: 'w-[16%]',
    priority: 'xl',
    render: (row) => (
      <span className="font-mono text-xs text-muted-foreground">{row.route ?? '—'}</span>
    ),
  },
];

export default function HttpTrafficPage() {
  /*
   * kubitor's own dashboard is, by volume, the loudest thing on this screen —
   * every poll, every page view and every export is a request the ingress logs.
   * Hiding it by default is the difference between an access log and a mirror.
   * The exclusion lands in the URL, so it is visible and one click from gone.
   */
  const [ownHost, setOwnHost] = useState<string | undefined>(undefined);
  useEffect(() => setOwnHost(window.location.hostname), []);

  return (
    <div className="screen gap-3">
      <div>
        <h1 className="text-base font-semibold tracking-tight">HTTP traffic</h1>
        <p className="text-sm text-muted-foreground">
          Requests as the ingress saw them. kubitor&rsquo;s own traffic is hidden by default — clear
          the second box to include it.
        </p>
      </div>
      <FacetTable<AccessRow>
        facet="http-access"
        columns={columns}
        filters={[{ key: 'method', label: 'Methods', values: ['GET', 'POST', 'PUT', 'DELETE'] }]}
        searchPlaceholder="Find a request by path, host, client or router"
        excludable
        excludePlaceholder="Hide requests matching…"
        detailFields={['user_agent', 'service', 'node', 'integration', 'attrs']}
        {...(ownHost ? { defaultExclude: ownHost } : {})}
        emptyMessage="No request matches these filters."
      />
    </div>
  );
}
