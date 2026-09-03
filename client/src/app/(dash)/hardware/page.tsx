'use client';

import { type Column, FacetTable } from '@/components/facet-table';
import { formatCelsius, formatTimestamp } from '@/lib/format';

interface HardwareRow extends Record<string, unknown> {
  at: number;
  node: string;
  cpu_mhz: number | null;
  temps: Record<string, number>;
}

const columns: Column<HardwareRow>[] = [
  {
    key: 'at',
    header: 'When',
    render: (row) => <span className="font-mono text-xs">{formatTimestamp(row.at)}</span>,
  },
  { key: 'node', header: 'Node', render: (row) => <span className="font-medium">{row.node}</span> },
  {
    key: 'cpu_mhz',
    header: 'Clock',
    align: 'right',
    render: (row) => (row.cpu_mhz === null ? '—' : `${row.cpu_mhz} MHz`),
  },
  {
    key: 'temps',
    header: 'Temperatures',
    render: (row) => {
      const entries = Object.entries(row.temps ?? {});
      if (entries.length === 0) {
        // The agent omits a sensor it could not read rather than calling it 0 °C.
        return <span className="text-blind">no sensor readable</span>;
      }
      return (
        <span className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-xs">
          {entries.map(([label, celsius]) => (
            <span key={label}>
              <span className="text-muted-foreground">{label}</span> {formatCelsius(celsius)}
            </span>
          ))}
        </span>
      );
    },
  },
];

export default function HardwarePage() {
  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Hardware</h1>
        <p className="text-sm text-muted-foreground">
          Reported by the optional agent. Sensors that cannot be read are left out rather than
          reported as zero.
        </p>
      </div>
      <FacetTable<HardwareRow>
        facet="hardware"
        columns={columns}
        searchPlaceholder="Find a node"
        emptyMessage="No agent is reporting. Install the DaemonSet to see host temperatures."
      />
    </div>
  );
}
