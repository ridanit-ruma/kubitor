'use client';

import { type Column, FacetTable } from '@/components/facet-table';
import { Badge } from '@/components/ui/badge';
import { formatBytes, formatCpu, formatPercent, formatTimestamp } from '@/lib/format';

/**
 * One machine the agent reports on, whether or not it is a cluster node.
 *
 * The shape is `host.resources`: what the machine is, as opposed to what the
 * cluster thinks of it.
 */
interface HostRow extends Record<string, unknown> {
  node: string;
  observed_at: number;
  cpu_model: string | null;
  cpu_cores: number | null;
  cpu_percent: number | null;
  load1: number | null;
  mem_total_bytes: number | null;
  mem_used_bytes: number | null;
}

/** Load as a share of the machine, so the reader is not asked to divide. */
function loadShare(row: HostRow): number | null {
  if (row.load1 === null || !row.cpu_cores) return null;
  return (row.load1 / row.cpu_cores) * 100;
}

const columns: Column<HostRow>[] = [
  {
    key: 'node',
    header: 'Host',
    render: (row) => <span className="font-medium">{row.node}</span>,
  },
  {
    key: 'cpu_model',
    header: 'Processor',
    width: 'w-[30%]',
    priority: 'md',
    render: (row) => (
      <span className="font-mono text-xs text-muted-foreground">{row.cpu_model ?? '—'}</span>
    ),
  },
  {
    key: 'cpu_cores',
    header: 'Threads',
    width: 'w-[10%]',
    priority: 'lg',
    align: 'right',
    render: (row) => formatCpu(row.cpu_cores === null ? null : row.cpu_cores * 1000),
  },
  {
    key: 'cpu_percent',
    header: 'CPU',
    width: 'w-[10%]',
    priority: 'sm',
    align: 'right',
    render: (row) => formatPercent(row.cpu_percent),
  },
  {
    key: 'load1',
    header: 'Load',
    width: 'w-[10%]',
    priority: 'lg',
    align: 'right',
    render: (row) => formatPercent(loadShare(row)),
  },
  {
    // Used beside the total, never alone: a bare 2.1 GiB says nothing about
    // whether the machine is under pressure.
    key: 'mem_used_bytes',
    header: 'Memory',
    width: 'w-[18%]',
    priority: 'sm',
    align: 'right',
    render: (row) => (
      <span>
        {formatBytes(row.mem_used_bytes)}
        <span className="text-muted-foreground"> / {formatBytes(row.mem_total_bytes)}</span>
      </span>
    ),
  },
  {
    key: 'observed_at',
    header: 'Last report',
    width: 'w-[18%]',
    priority: 'xl',
    render: (row) => (
      <span className="font-mono text-xs text-muted-foreground">
        {formatTimestamp(row.observed_at)}
      </span>
    ),
  },
];

/**
 * Every machine an agent reports on.
 *
 * This screen exists because a cluster is rarely the whole estate. It only
 * appears in the navigation once a machine outside the cluster reports — with
 * agents on nodes alone it would answer exactly the question Nodes answers.
 */
export default function HostsPage() {
  return (
    <div className="screen gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-base font-semibold tracking-tight">Hosts</h1>
        <Badge variant="outline" className="font-normal">
          machines running the agent
        </Badge>
      </div>

      <FacetTable<HostRow>
        facet="resources"
        columns={columns}
        searchPlaceholder="Find a machine by name or processor"
        emptyMessage="No agent is reporting. Install one, or issue a token under Settings → Agents."
        onRowHref={(row) => `/hosts/${encodeURIComponent(row.node)}`}
        rowKey={(row) => row.node}
      />
    </div>
  );
}
