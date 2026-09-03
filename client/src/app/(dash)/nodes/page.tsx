'use client';

import { type Column, FacetTable } from '@/components/facet-table';
import { Badge } from '@/components/ui/badge';
import { formatBytes, formatCount, formatCpu } from '@/lib/format';

interface NodeRow extends Record<string, unknown> {
  name: string;
  roles: string;
  ready: number;
  kubelet_version: string;
  os_image: string;
  architecture: string;
  capacity_cpu_milli: number;
  capacity_memory_bytes: number;
  capacity_pods: number;
}

const columns: Column<NodeRow>[] = [
  { key: 'name', header: 'Node', render: (row) => <span className="font-medium">{row.name}</span> },
  {
    key: 'ready',
    header: 'State',
    width: 'w-[10%]',
    render: (row) =>
      row.ready === 1 ? (
        <Badge variant="secondary">Ready</Badge>
      ) : (
        <Badge variant="destructive">Not ready</Badge>
      ),
  },
  {
    key: 'roles',
    header: 'Roles',
    width: 'w-[12%]',
    priority: 'md',
    render: (row) => (
      <span className="font-mono text-xs">{row.roles === '' ? 'worker' : row.roles}</span>
    ),
  },
  {
    key: 'capacity_cpu_milli',
    header: 'CPU',
    width: 'w-[10%]',
    align: 'right',
    render: (row) => formatCpu(row.capacity_cpu_milli),
  },
  {
    key: 'capacity_memory_bytes',
    header: 'Memory',
    width: 'w-[12%]',
    align: 'right',
    render: (row) => formatBytes(row.capacity_memory_bytes),
  },
  {
    key: 'capacity_pods',
    header: 'Pod slots',
    width: 'w-[10%]',
    priority: 'lg',
    align: 'right',
    render: (row) => formatCount(row.capacity_pods),
  },
  {
    key: 'kubelet_version',
    header: 'Kubelet',
    width: 'w-[12%]',
    priority: 'lg',
    render: (row) => <span className="font-mono text-xs">{row.kubelet_version}</span>,
  },
  {
    key: 'os_image',
    header: 'OS',
    width: 'w-[16%]',
    priority: 'xl',
    render: (row) => (
      <span className="font-mono text-xs text-muted-foreground">{row.os_image}</span>
    ),
  },
];

export default function NodesPage() {
  return (
    <div className="screen gap-3">
      <h1 className="text-lg font-semibold tracking-tight">Nodes</h1>
      <FacetTable<NodeRow>
        facet="nodes"
        columns={columns}
        filters={[{ key: 'ready', label: 'States', values: ['1', '0'] }]}
        searchPlaceholder="Find a node by name, OS or kubelet version"
        emptyMessage="No node has been collected yet."
        onRowHref={(row) => `/nodes/${encodeURIComponent(row.name)}`}
      />
    </div>
  );
}
