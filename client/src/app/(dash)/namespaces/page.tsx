'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { api } from '@/lib/api';
import { formatCount } from '@/lib/format';

interface Summary {
  namespace: string;
  pods: number;
  notReady: number;
  restarts: number;
}

/**
 * Namespaces are a rollup of workloads rather than a facet of their own: the
 * question people ask here is "which namespace is unhappy", not "what
 * namespaces exist".
 */
export default function NamespacesPage() {
  const [rows, setRows] = useState<Summary[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void (async () => {
      const page = await api.facet('workloads', new URLSearchParams({ limit: '500' }));
      const byNamespace = new Map<string, Summary>();

      for (const row of page.rows) {
        const namespace = String(row.namespace);
        const summary = byNamespace.get(namespace) ?? {
          namespace,
          pods: 0,
          notReady: 0,
          restarts: 0,
        };
        summary.pods += 1;
        if (row.ready !== 1) summary.notReady += 1;
        summary.restarts += Number(row.restarts ?? 0);
        byNamespace.set(namespace, summary);
      }

      setRows([...byNamespace.values()].sort((a, b) => a.namespace.localeCompare(b.namespace)));
      setLoading(false);
    })();
  }, []);

  return (
    <div className="screen gap-3">
      <h1 className="text-base font-semibold tracking-tight">Namespaces</h1>

      <div className="pane rounded-lg border border-line">
        <Table className="table-fixed">
          <TableHeader className="sticky top-0 z-10 bg-card">
            <TableRow>
              <TableHead className="truncate font-mono text-[11px] uppercase tracking-[0.1em]">
                Namespace
              </TableHead>
              <TableHead className="w-[18%] truncate text-right font-mono text-[11px] uppercase tracking-[0.1em] sm:w-[14%]">
                Pods
              </TableHead>
              <TableHead className="w-[26%] truncate text-right font-mono text-[11px] uppercase tracking-[0.1em] sm:w-[16%]">
                Not ready
              </TableHead>
              <TableHead className="hidden w-[16%] truncate text-right font-mono text-[11px] uppercase tracking-[0.1em] md:table-cell">
                Restarts
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {!loading && rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={4} className="py-8 text-center text-muted-foreground">
                  No workload has been collected yet.
                </TableCell>
              </TableRow>
            )}
            {rows.map((row) => (
              <TableRow key={row.namespace}>
                <TableCell className="max-w-0 truncate">
                  <Link
                    href={`/workloads?namespace=${encodeURIComponent(row.namespace)}`}
                    className="font-mono text-sm underline-offset-4 hover:underline"
                  >
                    {row.namespace}
                  </Link>
                </TableCell>
                <TableCell className="text-right tabular">{formatCount(row.pods)}</TableCell>
                <TableCell className="text-right tabular">
                  <span className={row.notReady > 0 ? 'text-blind' : undefined}>
                    {formatCount(row.notReady)}
                  </span>
                </TableCell>
                <TableCell className="hidden text-right tabular md:table-cell">
                  {formatCount(row.restarts)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
