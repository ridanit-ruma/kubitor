import { type Kysely, sql } from 'kysely';
import type { DialectSql } from '../db/dialect.js';
import type { Database } from '../db/schema.js';
import { type FacetDescriptor, facetDescriptor } from '../plugins/facets.js';
import { type ClusterTrafficPoint, clusterTraffic } from './cluster-series.js';
import { type ClusterSummary, clusterSummary } from './cluster-summary.js';

export interface QueryFilters {
  /** Column equality filters; only whitelisted columns are honoured. */
  equals?: Record<string, string>;
  /** Case-insensitive substring match across the facet's searchable columns. */
  search?: string;
  /**
   * Rows matching this substring are hidden.
   *
   * The counterpart to `search`, and the reason it exists: on a busy cluster
   * most of what an access log holds is traffic the reader already knows about,
   * and the useful question is "everything except that" rather than "only this".
   */
  exclude?: string;
  since?: number;
  until?: number;
  limit?: number;
  offset?: number;
}

export interface QueryResult {
  rows: Record<string, unknown>[];
  total: number;
}

/** Columns a caller may filter or search on, per facet. */
const QUERYABLE: Record<string, { filter: readonly string[]; search: readonly string[] }> = {
  'http.access': {
    filter: ['integration', 'node', 'host', 'method', 'status', 'route', 'service'],
    search: ['path', 'host', 'client_ip', 'user_agent', 'route'],
  },
  'http.routes': {
    filter: ['integration', 'kind', 'namespace', 'class'],
    search: ['name', 'host', 'path', 'service'],
  },
  nodes: { filter: ['integration', 'ready'], search: ['name', 'os_image', 'kubelet_version'] },
  workloads: {
    filter: ['integration', 'namespace', 'node', 'phase', 'reason', 'kind', 'owner_kind'],
    search: ['name', 'images', 'owner_name', 'reason'],
  },
  events: {
    filter: ['integration', 'namespace', 'type', 'kind', 'reason'],
    search: ['name', 'message', 'reason'],
  },
  'host.hardware': { filter: ['integration', 'node'], search: ['node'] },
  'host.resources': { filter: ['integration', 'node'], search: ['node', 'cpu_model'] },
};

export const MAX_PAGE = 500;

/**
 * One query path for every facet screen and every export.
 *
 * Filters are driven by an allow-list rather than by whatever the caller names,
 * so a query string cannot reach a column the screen never meant to expose.
 */
export class FacetQuery {
  readonly #db: Kysely<Database>;
  readonly #sql: DialectSql;

  constructor(db: Kysely<Database>, dialect: DialectSql) {
    this.#db = db;
    this.#sql = dialect;
  }

  descriptorFor(facet: string): FacetDescriptor | undefined {
    return facetDescriptor(facet);
  }

  /** The cluster in a dozen numbers, counted in the database. */
  async summary(now: number): Promise<ClusterSummary> {
    return clusterSummary(this.#db, now);
  }

  /** What every node moved over a window, summed. */
  async traffic(since: number, until: number, widthMs: number): Promise<ClusterTrafficPoint[]> {
    return clusterTraffic(this.#db, since, until, widthMs);
  }

  async run(facet: string, filters: QueryFilters): Promise<QueryResult> {
    const descriptor = facetDescriptor(facet);
    if (!descriptor) throw new Error(`Unknown facet ${facet}`);

    const allowed = QUERYABLE[facet] ?? { filter: [], search: [] };
    const table = descriptor.table as keyof Database;

    const applyFilters = <T>(query: T): T => {
      // biome-ignore lint/suspicious/noExplicitAny: table is chosen by descriptor
      let builder = query as any;

      for (const [column, value] of Object.entries(filters.equals ?? {})) {
        if (!allowed.filter.includes(column)) continue;
        builder = builder.where(column, '=', coerce(column, value));
      }

      if (filters.since !== undefined) {
        builder = builder.where(descriptor.timeColumn, '>=', filters.since);
      }
      if (filters.until !== undefined) {
        builder = builder.where(descriptor.timeColumn, '<=', filters.until);
      }

      /* The table is chosen by the descriptor at runtime, so Kysely cannot
       * name its columns and the expression builder has no usable type. */
      // biome-ignore lint/suspicious/noExplicitAny: explained above
      type ExpressionBuilderLike = any;

      const search = filters.search?.trim();
      if (search && allowed.search.length > 0) {
        builder = builder.where((eb: ExpressionBuilderLike) =>
          eb.or(allowed.search.map((column) => matches(column, search))),
        );
      }

      const exclude = filters.exclude?.trim();
      if (exclude && allowed.search.length > 0) {
        // `NOT (a OR b)` is the wrong shape here: a nullable column makes the
        // OR unknown rather than false, `NOT unknown` is unknown, and the row
        // is dropped. Requiring every column to not match keeps the nulls —
        // which `matches` has already coalesced — out of the logic.
        builder = builder.where((eb: ExpressionBuilderLike) =>
          eb.and(allowed.search.map((column) => eb.not(matches(column, exclude)))),
        );
      }

      return builder as T;
    };

    const countRow = (await applyFilters(
      this.#db.selectFrom(table).select((eb) => eb.fn.countAll().as('n')),
      // biome-ignore lint/suspicious/noExplicitAny: table is chosen by descriptor
    ).executeTakeFirstOrThrow()) as any;

    const limit = Math.min(Math.max(filters.limit ?? 100, 1), MAX_PAGE);
    const rows = await applyFilters(this.#db.selectFrom(table).selectAll())
      // biome-ignore lint/suspicious/noExplicitAny: table is chosen by descriptor
      .orderBy(descriptor.timeColumn as any, 'desc')
      .limit(limit)
      .offset(Math.max(filters.offset ?? 0, 0))
      .execute();

    return {
      total: Number(countRow.n),
      rows: rows.map((row) => this.#decode(descriptor, row as Record<string, unknown>)),
    };
  }

  /** Streams every matching row for export, in pages, without a total. */
  async *stream(
    facet: string,
    filters: QueryFilters,
    maxRows: number,
  ): AsyncGenerator<Record<string, unknown>> {
    let offset = 0;
    let emitted = 0;

    while (emitted < maxRows) {
      const page = await this.run(facet, { ...filters, limit: MAX_PAGE, offset });
      if (page.rows.length === 0) return;

      for (const row of page.rows) {
        if (emitted >= maxRows) return;
        yield row;
        emitted += 1;
      }

      offset += page.rows.length;
    }
  }

  #decode(descriptor: FacetDescriptor, row: Record<string, unknown>): Record<string, unknown> {
    const decoded = { ...row };
    for (const column of descriptor.jsonColumns) {
      if (decoded[column] !== undefined) {
        decoded[column] = this.#sql.decodeJson(decoded[column]);
      }
    }
    // PostgreSQL returns bigint columns as strings; screens want numbers.
    decoded[descriptor.timeColumn] = Number(decoded[descriptor.timeColumn]);
    return decoded;
  }
}

/** Numeric columns arrive as query-string text. */
function coerce(column: string, value: string): string | number {
  if (['status', 'ready', 'tls', 'port', 'count', 'restarts'].includes(column)) {
    return Number(value);
  }
  return value;
}

/**
 * Case-insensitive substring match on one column.
 *
 * Written as raw SQL for two reasons. `coalesce` keeps a nullable column out of
 * three-valued logic, so a row with no user agent is simply "does not match"
 * rather than "unknown". And `ESCAPE` has to be stated: PostgreSQL assumes a
 * backslash, SQLite assumes nothing at all, so without it the escaping below
 * silently means different things on the two dialects kubitor supports.
 */
function matches(column: string, term: string) {
  const pattern = `%${escapeLike(term.toLowerCase())}%`;
  return sql<boolean>`lower(coalesce(${sql.ref(column)}, '')) like ${pattern} escape '\\'`;
}

/** `%` and `_` are wildcards in LIKE; a user searching for them means literals. */
function escapeLike(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
}
