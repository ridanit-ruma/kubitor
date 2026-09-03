'use client';

import { type Column, FacetTable } from '@/components/facet-table';
import { Badge } from '@/components/ui/badge';
import { formatCount, formatTimestamp } from '@/lib/format';

interface EventRow extends Record<string, unknown> {
  at: number;
  namespace: string;
  kind: string;
  name: string;
  reason: string;
  message: string;
  type: string;
  count: number;
}

const columns: Column<EventRow>[] = [
  {
    key: 'at',
    header: 'When',
    render: (row) => <span className="font-mono text-xs">{formatTimestamp(row.at)}</span>,
  },
  {
    key: 'type',
    header: 'Type',
    render: (row) => (
      <Badge variant={row.type === 'Warning' ? 'destructive' : 'secondary'}>{row.type}</Badge>
    ),
  },
  { key: 'reason', header: 'Reason', render: (row) => row.reason },
  {
    key: 'name',
    header: 'Object',
    priority: 'md',
    render: (row) => (
      <span className="font-mono text-xs">
        {row.kind}/{row.name}
      </span>
    ),
  },
  {
    key: 'namespace',
    header: 'Namespace',
    priority: 'lg',
    render: (row) => <span className="font-mono text-xs">{row.namespace}</span>,
  },
  {
    key: 'message',
    header: 'Message',
    priority: 'xl',
    render: (row) => <span className="text-xs text-muted-foreground">{row.message}</span>,
  },
  { key: 'count', header: 'Count', align: 'right', render: (row) => formatCount(row.count) },
];

export default function EventsPage() {
  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <h1 className="text-lg font-semibold tracking-tight">Events</h1>
      <FacetTable<EventRow>
        facet="events"
        columns={columns}
        filters={[{ key: 'type', label: 'Types', values: ['Normal', 'Warning'] }]}
        searchPlaceholder="Find an event by object, reason or message"
        emptyMessage="No event matches these filters."
      />
    </div>
  );
}
