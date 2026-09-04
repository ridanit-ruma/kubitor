import type { Column } from '@/components/facet-table';
import { Badge } from '@/components/ui/badge';

/**
 * One address the cluster answers on, as every ingress reports it.
 *
 * The vendor-neutral shape. Whatever else a particular ingress knows about a
 * route travels in `attrs`, and is rendered by that vendor's own columns below.
 */
export interface RouteRow extends Record<string, unknown> {
  kind: string;
  namespace: string;
  name: string;
  host: string;
  path: string;
  service: string;
  port: number | null;
  tls: number;
  class: string | null;
  integration: string;
  attrs: { match?: string | null };
}

/** What the screen shows whichever ingress is installed. */
const BASE_COLUMNS: Column<RouteRow>[] = [
  {
    key: 'host',
    header: 'Address',
    width: 'w-[34%]',
    render: (row) => (
      <span className="font-mono text-xs">
        {row.host}
        <span className="text-muted-foreground">{row.path}</span>
      </span>
    ),
  },
  {
    key: 'service',
    header: 'Backend',
    width: 'w-[24%]',
    priority: 'sm',
    render: (row) => (
      <span className="font-mono text-xs">
        {row.service}
        {row.port === null ? '' : `:${row.port}`}
      </span>
    ),
  },
  {
    key: 'tls',
    header: 'TLS',
    width: 'w-[22%] sm:w-[10%]',
    render: (row) =>
      row.tls === 1 ? (
        <Badge variant="secondary">TLS</Badge>
      ) : (
        <Badge variant="outline">plain</Badge>
      ),
  },
  {
    key: 'namespace',
    header: 'Namespace',
    width: 'w-[16%]',
    priority: 'md',
    render: (row) => <span className="font-mono text-xs">{row.namespace}</span>,
  },
  {
    key: 'integration',
    header: 'Served by',
    width: 'w-[16%]',
    priority: 'lg',
    render: (row) => (
      <span className="font-mono text-xs text-muted-foreground">
        {row.integration} · {row.kind}
      </span>
    ),
  },
];

/**
 * What each ingress adds to that shape, mounted only where it is installed.
 *
 * This is the whole of "normalization first, vendor depth second": a cluster
 * running Traefik does not get a second list of the same addresses, it gets the
 * one list with Traefik's own column in it. An ingress with nothing extra to
 * say adds nothing, and the screen is the same screen.
 */
const VENDOR_COLUMNS: Record<string, Column<RouteRow>[]> = {
  traefik: [
    {
      key: 'attrs.match',
      header: 'Rule',
      width: 'w-[20%]',
      priority: 'lg',
      // Traefik's matcher expression, verbatim. This is the string an operator
      // compares against their manifest when a route misbehaves, and the reason
      // this vendor was worth a column of its own. An `Ingress` has no matcher,
      // so the rule Traefik derives from it is written out instead.
      render: (row) => (
        <span className="font-mono text-xs">
          {row.attrs?.match ?? (
            <span className="text-muted-foreground">
              Host(`{row.host}`)
              {row.path && row.path !== '/' ? ` && PathPrefix(\`${row.path}\`)` : ''}
            </span>
          )}
        </span>
      ),
    },
  ],
};

/** Kinds only a particular ingress can produce. */
const VENDOR_KINDS: Record<string, string[]> = {
  traefik: ['IngressRoute'],
};

/**
 * Room the neutral columns give up when a vendor column joins them.
 *
 * The table is fixed-layout, so the shares have to add up: without a vendor
 * column the five below come to a hundred at `lg`, and a sixth arriving has to
 * be paid for by the others rather than by overflowing. Narrowing applies at
 * the same breakpoint the vendor column appears at, and nowhere else.
 */
const NARROWED: Record<string, string> = {
  host: 'w-[34%] lg:w-[24%]',
  service: 'w-[24%] lg:w-[18%]',
  namespace: 'w-[16%] lg:w-[14%]',
  integration: 'w-[16%] lg:w-[14%]',
};

/**
 * The columns for a cluster, given what is feeding the routes facet.
 *
 * Vendor columns sit after `Address`, `Backend` and `TLS` — what the route is
 * comes before whose it is — and before the columns that only say where it came
 * from.
 */
export function routeColumns(sources: readonly string[]): Column<RouteRow>[] {
  const vendor = sources.flatMap((source) => VENDOR_COLUMNS[source] ?? []);
  if (vendor.length === 0) return BASE_COLUMNS;

  const paid = BASE_COLUMNS.map((column) => {
    const width = NARROWED[column.key];
    return width === undefined ? column : { ...column, width };
  });

  return [...paid.slice(0, 3), ...vendor, ...paid.slice(3)];
}

/**
 * The kinds worth offering as a filter.
 *
 * `Ingress` exists in every cluster; `IngressRoute` is a Traefik CRD, and
 * offering it where Traefik is not installed is a filter that can only ever
 * return nothing.
 */
export function routeKinds(sources: readonly string[]): string[] {
  return ['Ingress', ...sources.flatMap((source) => VENDOR_KINDS[source] ?? [])];
}
