'use client';

import { useEffect, useState } from 'react';
import { type Column, FacetTable } from '@/components/facet-table';
import { Badge } from '@/components/ui/badge';
import { api } from '@/lib/api';
import { formatCount, formatTimestamp } from '@/lib/format';

interface WorkloadRow extends Record<string, unknown> {
  namespace: string;
  name: string;
  node: string | null;
  phase: string;
  ready: number;
  restarts: number;
  images: string;
  created_at: number;
}

const columns: Column<WorkloadRow>[] = [
  { key: 'name', header: 'Pod', render: (row) => <span className="font-medium">{row.name}</span> },
  {
    key: 'namespace',
    header: 'Namespace',
    render: (row) => <span className="font-mono text-xs">{row.namespace}</span>,
  },
  {
    key: 'node',
    header: 'Node',
    priority: 'md',
    render: (row) => <span className="font-mono text-xs">{row.node ?? '—'}</span>,
  },
  {
    key: 'phase',
    header: 'Phase',
    render: (row) => (
      <Badge variant={row.phase === 'Running' && row.ready === 1 ? 'secondary' : 'outline'}>
        {row.phase}
        {row.ready === 1 ? '' : ' · not ready'}
      </Badge>
    ),
  },
  {
    key: 'restarts',
    header: 'Restarts',
    priority: 'md',
    align: 'right',
    render: (row) => (
      <span className={row.restarts > 0 ? 'text-blind' : undefined}>
        {formatCount(row.restarts)}
      </span>
    ),
  },
  {
    key: 'images',
    header: 'Image',
    priority: 'xl',
    render: (row) => <span className="font-mono text-xs text-muted-foreground">{row.images}</span>,
  },
  {
    key: 'created_at',
    header: 'Created',
    priority: 'lg',
    align: 'right',
    render: (row) => (
      <span className="font-mono text-xs text-muted-foreground">
        {formatTimestamp(row.created_at)}
      </span>
    ),
  },
];

export default function WorkloadsPage() {
  const [namespaces, setNamespaces] = useState<string[]>([]);
  const [nodes, setNodes] = useState<string[]>([]);

  useEffect(() => {
    void (async () => {
      const [workloads, nodeRows] = await Promise.allSettled([
        api.facet('workloads', new URLSearchParams({ limit: '500' })),
        api.facet('nodes', new URLSearchParams({ limit: '500' })),
      ]);

      if (workloads.status === 'fulfilled') {
        setNamespaces(
          [...new Set(workloads.value.rows.map((row) => String(row.namespace)))].sort(),
        );
      }
      if (nodeRows.status === 'fulfilled') {
        setNodes([...new Set(nodeRows.value.rows.map((row) => String(row.name)))].sort());
      }
    })();
  }, []);

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <h1 className="text-lg font-semibold tracking-tight">Workloads</h1>
      <FacetTable<WorkloadRow>
        facet="workloads"
        columns={columns}
        filters={[
          { key: 'namespace', label: 'Namespaces', values: namespaces },
          { key: 'node', label: 'Nodes', values: nodes },
          { key: 'phase', label: 'Phases', values: ['Running', 'Pending', 'Succeeded', 'Failed'] },
        ]}
        searchPlaceholder="Find a pod by name, image or owner"
        emptyMessage="No pod matches these filters."
      />
    </div>
  );
}
