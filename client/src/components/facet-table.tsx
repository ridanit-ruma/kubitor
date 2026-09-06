'use client';

import { Download, EyeOff, Search } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { Pager } from '@/components/pager';
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
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
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

/** The screen's own constraints, applied on top of whatever the reader chose. */
function withFixed(
  search: string,
  fixed: Readonly<Record<string, string>> | undefined,
): URLSearchParams {
  const params = new URLSearchParams(search);
  for (const [key, value] of Object.entries(fixed ?? {})) params.set(key, value);
  // The reader's page is a position, not a filter. It leaves here as an offset
  // and never reaches the server under its own name.
  params.delete('page');
  return params;
}

/** The page in the URL, as a number the rest of the component can trust. */
export function pageIn(params: URLSearchParams): number {
  const raw = Number(params.get('page'));
  return Number.isInteger(raw) && raw >= 1 ? raw : 1;
}

/**
 * How important a column is.
 *
 * Narrow viewports drop the low-priority columns rather than scrolling
 * sideways: a table that scrolls horizontally hides data behind a gesture
 * nobody performs. What disappears stays reachable on the row's detail page.
 */
export type ColumnPriority = 'always' | 'sm' | 'md' | 'lg' | 'xl';

const PRIORITY_CLASS: Record<ColumnPriority, string> = {
  always: '',
  sm: 'hidden sm:table-cell',
  md: 'hidden md:table-cell',
  lg: 'hidden lg:table-cell',
  xl: 'hidden xl:table-cell',
};

export interface Column<Row> {
  key: string;
  header: string;
  priority?: ColumnPriority;
  align?: 'left' | 'right';
  /**
   * Share of the table's width, as a Tailwind width class.
   *
   * The table is fixed-layout so that nothing can push it sideways, which means
   * a column that needs room has to ask for it.
   */
  width?: string;
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
  /**
   * Filters the screen always applies and the reader cannot change.
   *
   * A vendor's own screen is the case: it is about that vendor's rows and
   * nothing else, and the constraint belongs to the screen rather than to a
   * dropdown the reader has to remember to set.
   */
  fixed?: Readonly<Record<string, string>>;
  searchPlaceholder: string;
  emptyMessage: string;
  onRowHref?(row: Row): string | undefined;
  /** A stable identity for the row; falls back to its whole content. */
  rowKey?(row: Row): string;
  /**
   * Extra fields to show when a row is opened, beyond the visible columns.
   *
   * Columns hidden at this width are always included; this is for values the
   * table never shows at any width.
   */
  detailFields?: readonly string[];
  pageSize?: number;
  /** Offers the exclusion box. Worth it where most rows are noise. */
  excludable?: boolean;
  excludePlaceholder?: string;
  /**
   * An exclusion applied on first visit.
   *
   * Written into the URL rather than held privately, so the filter is visible,
   * removable in one click, and carried into the export like every other one.
   */
  defaultExclude?: string;
}

/**
 * How long a keystroke waits before it becomes a request.
 *
 * Without this, typing "traefik" is seven navigations, seven facet queries and
 * seven RSC fetches — every one of them recorded in the cluster's own access
 * log, which is the screen the user is usually typing into.
 */
const TYPING_SETTLE_MS = 250;

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
  fixed,
  searchPlaceholder,
  emptyMessage,
  onRowHref,
  rowKey,
  detailFields,
  pageSize = 100,
  excludable = false,
  excludePlaceholder = 'Hide rows matching…',
  defaultExclude,
}: FacetTableProps<Row>) {
  const router = useRouter();
  const params = useSearchParams();

  const [rows, setRows] = useState<Row[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [opened, setOpened] = useState<Row | null>(null);

  // The query string is the single source of truth for what is shown, so the
  // effect below depends on it rather than on the router object.
  const search = params.toString();
  const fixedKey = JSON.stringify(fixed ?? {});
  const page = pageIn(params);
  const query = withFixed(search, fixed);
  query.set('limit', String(pageSize));

  const setParam = (key: string, value: string | null): void => {
    const next = new URLSearchParams(params.toString());
    if (value === null || value === '' || value === '__all') next.delete(key);
    else next.set(key, value);
    // Any other change re-cuts the result set, and page four of the old one
    // names nothing in the new one.
    if (key !== 'page') next.delete('page');
    router.replace(`?${next.toString()}`, { scroll: false });
  };

  const settle = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const setParamWhenTypingStops = (key: string, value: string): void => {
    const pending = settle.current.get(key);
    if (pending) clearTimeout(pending);
    settle.current.set(
      key,
      setTimeout(() => setParam(key, value), TYPING_SETTLE_MS),
    );
  };

  useEffect(() => {
    const timers = settle.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, []);

  const seededDefault = useRef(false);
  const applied = params.toString();
  useEffect(() => {
    if (!defaultExclude || seededDefault.current) return;
    seededDefault.current = true;

    // Only on a bare URL: a link someone shared, or a view they have already
    // filtered, must keep meaning exactly what it says.
    const current = new URLSearchParams(applied);
    if (current.has('exclude') || current.has('search')) return;

    current.set('exclude', defaultExclude);
    router.replace(`?${current.toString()}`, { scroll: false });
  }, [defaultExclude, applied, router]);

  /*
   * A link can name a page the current filters do not reach — someone shares
   * page 40, the log is swept, and the table comes back empty with no hint
   * that there is anything to see. Land them on the last page there is.
   */
  const pages = Math.max(1, Math.ceil(total / pageSize));
  useEffect(() => {
    if (loading || total === 0 || page <= pages) return;

    const next = new URLSearchParams(applied);
    if (pages === 1) next.delete('page');
    else next.set('page', String(pages));
    router.replace(`?${next.toString()}`, { scroll: false });
  }, [loading, total, page, pages, applied, router]);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      setLoading(true);
      setFailed(false);
      try {
        const request = withFixed(search, JSON.parse(fixedKey) as Record<string, string>);
        request.set('limit', String(pageSize));
        request.set('offset', String((page - 1) * pageSize));
        const result = await api.facet(facet, request);
        if (cancelled) return;
        setRows(result.rows as Row[]);
        setTotal(result.total);
      } catch {
        if (!cancelled) setFailed(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [facet, search, fixedKey, pageSize, page]);

  return (
    <div className="screen gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full max-w-xs">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="h-8 pl-8"
            placeholder={searchPlaceholder}
            defaultValue={params.get('search') ?? ''}
            onChange={(event) => setParamWhenTypingStops('search', event.target.value)}
          />
        </div>

        {excludable && (
          <div className="relative w-full max-w-xs">
            <EyeOff className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-blind" />
            <Input
              className="h-8 pl-8"
              placeholder={excludePlaceholder}
              defaultValue={params.get('exclude') ?? ''}
              onChange={(event) => setParamWhenTypingStops('exclude', event.target.value)}
            />
          </div>
        )}

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
            {loading ? 'loading' : countLabel(page, pageSize, rows.length, total)}
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

      {/*
       * Only this box scrolls, and only vertically.
       *
       * The table is fixed-layout and every cell truncates, so a long value
       * can never push the page sideways. What gets cut off is on the row's
       * own panel, one click away.
       */}
      <div className="pane rounded-lg border border-line">
        <Table className="table-fixed">
          <TableHeader className="sticky top-0 z-10 bg-card">
            <TableRow>
              {columns.map((column) => (
                <TableHead
                  key={column.key}
                  className={cn(
                    PRIORITY_CLASS[column.priority ?? 'always'],
                    column.align === 'right' && 'text-right',
                    column.width,
                    // Headers truncate for the same reason cells do: a heading
                    // that refuses to wrap is enough to push the table sideways.
                    'max-w-0 truncate font-mono text-[11px] uppercase tracking-[0.1em]',
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
                  className="cursor-pointer"
                  onClick={() => (href ? router.push(href) : setOpened(row))}
                >
                  {columns.map((column) => (
                    <TableCell
                      key={column.key}
                      className={cn(
                        PRIORITY_CLASS[column.priority ?? 'always'],
                        column.align === 'right' && 'text-right tabular',
                        column.width,
                        'max-w-0 truncate',
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

      {/*
       * Under the table and inside the same flow, so it moves with the rows it
       * belongs to rather than needing a scrollbar of its own to reach.
       */}
      <Pager
        page={page}
        pages={pages}
        onPage={(next) => setParam('page', next === 1 ? null : String(next))}
      />

      <RowDetail
        row={opened}
        columns={columns}
        extraFields={detailFields}
        onClose={() => setOpened(null)}
      />
    </div>
  );
}

/**
 * Everything about one row, including what the table had to cut.
 *
 * A panel rather than a page: these rows are a handful of fields, and pushing
 * the reader through a navigation to read six values they were already looking
 * at costs more than it gives. Rows with a screen of their own get a link
 * instead — see `onRowHref`.
 */
function RowDetail<Row extends Record<string, unknown>>({
  row,
  columns,
  extraFields,
  onClose,
}: {
  row: Row | null;
  columns: readonly Column<Row>[];
  extraFields: readonly string[] | undefined;
  onClose(): void;
}) {
  if (!row) return null;

  const fields = [...columns.map((column) => column.key), ...(extraFields ?? [])].filter(
    (key, index, all) => all.indexOf(key) === index && key in row,
  );

  return (
    <Sheet open onOpenChange={(next) => !next && onClose()}>
      <SheetContent side="right" className="w-full gap-0 overflow-y-auto sm:max-w-lg">
        <SheetHeader>
          <SheetTitle className="font-mono text-sm">Row detail</SheetTitle>
          <SheetDescription>Every field, including the ones the table trims.</SheetDescription>
        </SheetHeader>

        <dl className="flex flex-col gap-3 px-4 pb-6">
          {fields.map((key) => (
            <div key={key}>
              <dt className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
                {key.replaceAll('_', ' ')}
              </dt>
              <dd className="mt-0.5 break-words font-mono text-sm">{plain(row[key])}</dd>
            </div>
          ))}
        </dl>
      </SheetContent>
    </Sheet>
  );
}

/** A field as text, without pretending an object is a string. */
function plain(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'object') return JSON.stringify(value, null, 2);
  return String(value);
}

/**
 * Which rows of how many this page is showing.
 *
 * `100 of 812` invites the reader to wonder where the other 712 went; naming
 * the range answers that before it is asked, and says which way through the
 * list the reader has got.
 */
export function countLabel(page: number, pageSize: number, shown: number, total: number): string {
  if (total === 0 || shown === 0) return `0 of ${total.toLocaleString()}`;

  const first = (page - 1) * pageSize + 1;
  return `${first.toLocaleString()}\u2013${(first + shown - 1).toLocaleString()} of ${total.toLocaleString()}`;
}
