import {
  BadRequestException,
  Controller,
  Get,
  Inject,
  Param,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import type { LiveCache, LiveNodeMetrics } from '../collect/live-cache.js';
import type { HostSeriesPoint, NodeSamplesRepo, SeriesPoint } from '../db/node-samples.repo.js';
import { counterRate } from '../kube/rates.js';
import type { ClusterTrafficPoint } from '../query/cluster-series.js';
import type { ClusterSummary } from '../query/cluster-summary.js';
import { csvRow } from '../query/csv.js';
import type { FacetQuery, QueryFilters } from '../query/facet-query.js';
import { LIVE_CACHE, NODE_SAMPLES, QUERY_SERVICE } from '../tokens.js';
import { PasswordFreshGuard } from './password-fresh.guard.js';
import { SessionGuard } from './session.guard.js';

/** Rows one export may contain before it is truncated. */
export const EXPORT_ROW_CAP = 100_000;

const listQuery = z.object({
  search: z.string().max(256).optional(),
  exclude: z.string().max(256).optional(),
  since: z.coerce.number().int().optional(),
  until: z.coerce.number().int().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

/**
 * The longest window a chart may ask for.
 *
 * Matched to `node_samples` retention: offering a range the data cannot cover
 * would draw an authoritative-looking chart that is mostly absence.
 */
export const MAX_SERIES_MINUTES = 7 * 24 * 60;

const seriesQuery = z.object({
  minutes: z.coerce.number().int().min(1).max(MAX_SERIES_MINUTES).default(60),
});

/**
 * How many points a chart is worth drawing.
 *
 * A line is six hundred pixels wide at most. Beyond roughly one point per two
 * pixels the extra samples land on pixels that are already inked: the chart
 * gets slower and noisier without saying anything more.
 */
export const MAX_SERIES_POINTS = 480;

/** How often a reading reaches the database. Nothing finer exists to return. */
export const STORE_INTERVAL_MS = 15_000;

/**
 * The bucket a window needs, or zero where the stored samples are few enough.
 *
 * Rounding up to a whole number of storage intervals keeps every bucket holding
 * the same number of readings, so one bucket is never an average of two samples
 * next to a bucket that averaged three.
 */
export function bucketWidthFor(spanMs: number): number {
  const ideal = spanMs / MAX_SERIES_POINTS;
  if (ideal <= STORE_INTERVAL_MS) return 0;
  return Math.ceil(ideal / STORE_INTERVAL_MS) * STORE_INTERVAL_MS;
}

const FACET_BY_PATH: Record<string, string> = {
  nodes: 'nodes',
  workloads: 'workloads',
  events: 'events',
  'http-access': 'http.access',
  routes: 'http.routes',
  hardware: 'host.hardware',
  resources: 'host.resources',
};

@Controller('api')
@UseGuards(SessionGuard, PasswordFreshGuard)
export class QueryController {
  readonly #query: FacetQuery;
  readonly #samples: NodeSamplesRepo;
  readonly #cache: LiveCache;

  constructor(
    @Inject(QUERY_SERVICE) query: FacetQuery,
    @Inject(NODE_SAMPLES) samples: NodeSamplesRepo,
    @Inject(LIVE_CACHE) cache: LiveCache,
  ) {
    this.#query = query;
    this.#samples = samples;
    this.#cache = cache;
  }

  /** Live values for the dashboard's first paint; the socket keeps them fresh. */
  @Get('metrics/current')
  current(): { generatedAt: number; nodes: LiveNodeMetrics[] } {
    const now = Date.now();
    return { generatedAt: now, nodes: this.#cache.current(now) };
  }

  /**
   * The overview screen's one question: what is this cluster doing.
   *
   * Counted per request rather than cached: these are five aggregates over
   * tables holding thousands of rows, and a stale answer on the screen an
   * operator opens first is worse than the microseconds it costs.
   */
  @Get('overview')
  async overview(): Promise<ClusterSummary> {
    return this.#query.summary(Date.now());
  }

  /**
   * The cluster's throughput over a window.
   *
   * Bucketed the same way a node's series is, and always bucketed: nodes report
   * on their own clocks, so summing them means grouping them into the same
   * instants first.
   */
  @Get('overview/series')
  async overviewSeries(
    @Query() query: Record<string, string>,
  ): Promise<{ points: ClusterTrafficPoint[] }> {
    const parsed = seriesQuery.safeParse(query);
    if (!parsed.success) throw new BadRequestException({ error: 'invalid_query' });

    const until = Date.now();
    const spanMs = parsed.data.minutes * 60_000;
    const width = Math.max(STORE_INTERVAL_MS, bucketWidthFor(spanMs));

    return { points: await this.#query.traffic(until - spanMs, until, width) };
  }

  @Get('facets/:facet')
  async list(
    @Param('facet') facetPath: string,
    @Query() query: Record<string, string>,
  ): Promise<{ rows: Record<string, unknown>[]; total: number }> {
    const facet = FACET_BY_PATH[facetPath];
    if (!facet) throw new BadRequestException({ error: 'unknown_facet' });

    return this.#query.run(facet, filtersFrom(query));
  }

  @Get('nodes/:name/series')
  async series(
    @Param('name') name: string,
    @Query() query: Record<string, string>,
  ): Promise<{ node: string; points: SeriesPoint[]; rates: RatePoint[]; host: HostSeriesPoint[] }> {
    const parsed = seriesQuery.safeParse(query);
    if (!parsed.success) throw new BadRequestException({ error: 'invalid_query' });

    const until = Date.now();
    const spanMs = parsed.data.minutes * 60_000;
    const since = until - spanMs;
    const width = bucketWidthFor(spanMs);

    // Both sources, because only the screen knows whether this node runs an
    // agent — and it should not have to ask twice to find out.
    const [points, host] = await Promise.all([
      width === 0
        ? this.#samples.series(name, since, until)
        : this.#samples.bucketed(name, since, until, width),
      this.#samples.hostSeries(name, since, until, width),
    ]);

    return { node: name, points, rates: toRates(points), host };
  }

  /**
   * Exports exactly what the caller is looking at: the same facet, the same
   * filters. A download that quietly differs from the screen is worse than none.
   */
  @Get('export/:facet')
  async export(
    @Param('facet') facetPath: string,
    @Query() query: Record<string, string>,
    @Res() response: Response,
  ): Promise<void> {
    const facet = FACET_BY_PATH[facetPath];
    if (!facet) throw new BadRequestException({ error: 'unknown_facet' });

    const format = query.format === 'csv' ? 'csv' : 'json';
    const filters = filtersFrom(query);
    const descriptor = this.#query.descriptorFor(facet);
    if (!descriptor) throw new BadRequestException({ error: 'unknown_facet' });

    const stamp = new Date().toISOString().slice(0, 19).replaceAll(':', '-');
    response.setHeader(
      'Content-Disposition',
      `attachment; filename="kubitor-${facetPath}-${stamp}.${format}"`,
    );

    let written = 0;
    let columns: string[] = [];

    if (format === 'csv') {
      response.setHeader('Content-Type', 'text/csv; charset=utf-8');
      for await (const row of this.#query.stream(facet, filters, EXPORT_ROW_CAP)) {
        if (written === 0) {
          columns = Object.keys(row);
          response.write(`${csvRow(columns)}\n`);
        }
        response.write(`${csvRow(columns.map((column) => row[column]))}\n`);
        written += 1;
      }
    } else {
      response.setHeader('Content-Type', 'application/json; charset=utf-8');
      response.write('[');
      for await (const row of this.#query.stream(facet, filters, EXPORT_ROW_CAP)) {
        response.write(written === 0 ? JSON.stringify(row) : `,${JSON.stringify(row)}`);
        written += 1;
      }
      response.write(']');
    }

    // Say so rather than letting a silently short file look complete.
    if (written >= EXPORT_ROW_CAP) response.setHeader('X-Kubitor-Truncated', 'true');
    response.end();
  }
}

export interface RatePoint {
  at: number;
  netRxBytesPerSecond: number | null;
  netTxBytesPerSecond: number | null;
}

/** Cumulative counters are only meaningful as rates between adjacent samples. */
function toRates(points: readonly SeriesPoint[]): RatePoint[] {
  return points.map((point, index) => {
    const previous = index === 0 ? undefined : points[index - 1];

    return {
      at: point.at,
      netRxBytesPerSecond:
        point.netRxBytes === null || previous?.netRxBytes == null
          ? null
          : counterRate(
              { at: previous.at, value: previous.netRxBytes },
              {
                at: point.at,
                value: point.netRxBytes,
              },
            ),
      netTxBytesPerSecond:
        point.netTxBytes === null || previous?.netTxBytes == null
          ? null
          : counterRate(
              { at: previous.at, value: previous.netTxBytes },
              {
                at: point.at,
                value: point.netTxBytes,
              },
            ),
    };
  });
}

function filtersFrom(query: Record<string, string>): QueryFilters {
  const parsed = listQuery.safeParse(query);
  if (!parsed.success) throw new BadRequestException({ error: 'invalid_query' });

  const equals: Record<string, string> = {};
  for (const [key, value] of Object.entries(query)) {
    if (['search', 'exclude', 'since', 'until', 'limit', 'offset', 'format'].includes(key)) {
      continue;
    }
    if (typeof value === 'string') equals[key] = value;
  }

  return {
    equals,
    ...(parsed.data.search !== undefined ? { search: parsed.data.search } : {}),
    ...(parsed.data.exclude !== undefined ? { exclude: parsed.data.exclude } : {}),
    ...(parsed.data.since !== undefined ? { since: parsed.data.since } : {}),
    ...(parsed.data.until !== undefined ? { until: parsed.data.until } : {}),
    ...(parsed.data.limit !== undefined ? { limit: parsed.data.limit } : {}),
    ...(parsed.data.offset !== undefined ? { offset: parsed.data.offset } : {}),
  };
}
