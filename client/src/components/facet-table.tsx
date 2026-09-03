'use client';

import { Download } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { api, exportHref } from '@/lib/api';
import { cn } from '@/lib/utils';

/**
 * How important a column is.
 *
 * Narrow viewports drop the low-priority columns rather than scrolling
 * sideways: a table that scrolls horizontally hides data behind a gesture
 * nobody performs. What disappears stays reachable on the row's detail page.
 */
export type ColumnPriority = 'always' | 'md' | 'lg' | 'xl';

const PRIORITY_CLASS: Record<ColumnPriority, string> = {
  always: '',
  md: 'hidden md:table-cell',
  lg: 'hidden lg:table-cell',
  xl: 'hidden xl:table-cell',
};

export interface Column<Row> {
  key: string;
  header: string;
  priority?: ColumnPriority;
  align?: 'left' | 'right';
  render(row: Row): React.ReactNode;
}

export interface FilterOption {
  key: string;
  label: string;
  values: readonly string[];
}

interface FacetTableProps<Row> {
  facet: string;
  columns: readonly Column<Row>[];
  filters?: readonly FilterOption[];
  searchPlaceholder: string;
  emptyMessage: string;
  onRowHref?(row: Row): string | undefined;
  /** A stable identity for the row; falls back to its whole content. */
  rowKey?(row: Row): string;
  pageSize?: number;
}

/**
 * One table for every facet screen.
 *
 * Filter state lives in the URL, so a filtered view is a link a colleague can
 * open and the export button receives exactly the filters on screen.
 */
export function FacetTable<Row extends Record<string, unknown>>({
  facet,
  columns,
  filters = [],
  searchPlaceholder,
  emptyMessage,
  onRowHref,
  rowKey,
  pageSize = 100,
}: FacetTableProps<Row>) {
  const router = useRouter();
  const params = useSearchParams();

  const [rows, setRows] = useState<Row[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  // The query string is the single source of truth for what is shown, so the
  // effect below depends on it rather than on the router object.
  const search = params.toString();
  const query = new URLSearchParams(search);
  query.set('limit', String(pageSize));

  const setParam = (key: string, value: string | null): void => {
    const next = new URLSearchParams(params.toString());
    if (value === null || value === '' || value === '__all') next.delete(key);
    else next.set(key, value);
    router.replace(`?${next.toString()}`, { scroll: false });
  };

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      setLoading(true);
      setFailed(false);
      try {
        const request = new URLSearchParams(search);
        request.set('limit', String(pageSize));
        const page = await api.facet(facet, request);
        if (cancelled) return;
        setRows(page.rows as Row[]);
        setTotal(page.total);
      } catch {
        if (!cancelled) setFailed(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [facet, search, pageSize]);

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          className="h-8 w-full max-w-xs"
          placeholder={searchPlaceholder}
          defaultValue={params.get('search') ?? ''}
          onChange={(event) => setParam('search', event.target.value)}
        />

        {filters.map((filter) => (
          <Select
            key={filter.key}
            value={params.get(filter.key) ?? '__all'}
            onValueChange={(value) => setParam(filter.key, value)}
          >
            <SelectTrigger className="h-8 w-auto min-w-36" size="sm">
              <SelectValue placeholder={filter.label} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all">All {filter.label.toLowerCase()}</SelectItem>
              {filter.values.map((value) => (
                <SelectItem key={value} value={value}>
                  {value}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ))}

        <div className="ml-auto flex items-center gap-2">
          <span className="font-mono text-xs text-muted-foreground">
            {loading ? 'loading' : `${rows.length} of ${total.toLocaleString()}`}
          </span>
          <Button asChild variant="outline" size="sm">
            <a href={exportHref(facet, query, 'csv')} download>
              <Download className="size-3.5" />
              CSV
            </a>
          </Button>
          <Button asChild variant="outline" size="sm">
            <a href={exportHref(facet, query, 'json')} download>
              <Download className="size-3.5" />
              JSON
            </a>
          </Button>
        </div>
      </div>

      {/* Only this box scrolls, and only vertically. */}
      <div className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-line">
        <Table>
          <TableHeader className="sticky top-0 z-10 bg-card">
            <TableRow>
              {columns.map((column) => (
                <TableHead
                  key={column.key}
                  className={cn(
                    PRIORITY_CLASS[column.priority ?? 'always'],
                    column.align === 'right' && 'text-right',
                    'font-mono text-[11px] uppercase tracking-[0.1em]',
                  )}
                >
                  {column.header}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>

          <TableBody>
            {failed && (
              <TableRow>
                <TableCell colSpan={columns.length} className="py-8 text-center text-blind">
                  Could not read this from the server. It may still be starting.
                </TableCell>
              </TableRow>
            )}

            {!failed && !loading && rows.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={columns.length}
                  className="py-8 text-center text-muted-foreground"
                >
                  {emptyMessage}
                </TableCell>
              </TableRow>
            )}

            {rows.map((row) => {
              const href = onRowHref?.(row);
              return (
                <TableRow
                  key={rowKey ? rowKey(row) : JSON.stringify(row)}
                  className={cn(href && 'cursor-pointer')}
                  onClick={href ? () => router.push(href) : undefined}
                >
                  {columns.map((column) => (
                    <TableCell
                      key={column.key}
                      className={cn(
                        PRIORITY_CLASS[column.priority ?? 'always'],
                        column.align === 'right' && 'text-right tabular',
                      )}
                    >
                      {column.render(row)}
                    </TableCell>
                  ))}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
