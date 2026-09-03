import { beforeEach, expect, it } from 'vitest';
import { migrateToLatest } from '../db/migrate.js';
import { describeEachDialect } from '../test/db-harness.js';
import { IngestPipeline } from './ingest.js';

const NOW = 1_756_800_000_000;
const DAY_MS = 86_400_000;

function access(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    at: NOW,
    host: 'kubitor.example',
    method: 'GET',
    path: '/',
    status: 200,
    duration_ms: 12,
    client_ip: '198.51.100.1',
    ...overrides,
  };
}

function route(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    observed_at: NOW,
    kind: 'Ingress',
    namespace: 'default',
    name: 'web',
    host: 'kubitor.example',
    path: '/',
    service: 'web',
    tls: 1,
    ...overrides,
  };
}

describeEachDialect('IngestPipeline event facets', (ctx) => {
  let pipeline: IngestPipeline;

  beforeEach(async () => {
    await migrateToLatest(ctx.db, ctx.kind);
    pipeline = new IngestPipeline(ctx.db, ctx.sqlHelper);
    await ctx.db.deleteFrom('facet_http_access').execute();
  });

  it('stores a valid batch', async () => {
    const report = await pipeline.ingest('traefik', 'http.access', [access(), access()], NOW);

    expect(report).toEqual({ accepted: 2, dropped: 0, reasons: {} });
    expect(await count(ctx, 'facet_http_access')).toBe(2);
  });

  /**
   * The rule the whole pipeline exists for. A deployed sender only advances its
   * buffer on success, so failing the batch would wedge the stream forever —
   * and anyone who can reach the endpoint could trigger it deliberately.
   */
  it('drops only the bad row and still succeeds', async () => {
    const report = await pipeline.ingest(
      'traefik',
      'http.access',
      [access(), { at: NOW, host: 'x' }, access()],
      NOW,
    );

    expect(report.accepted).toBe(2);
    expect(report.dropped).toBe(1);
    expect(report.reasons.invalid_row).toBe(1);
    expect(await count(ctx, 'facet_http_access')).toBe(2);
  });

  it('reports an unknown facet instead of throwing', async () => {
    const report = await pipeline.ingest('traefik', 'not.a.facet', [access()], NOW);

    expect(report.dropped).toBe(1);
    expect(report.reasons.unknown_facet).toBe(1);
  });

  it('accepts an empty batch', async () => {
    expect(await pipeline.ingest('traefik', 'http.access', [], NOW)).toEqual({
      accepted: 0,
      dropped: 0,
      reasons: {},
    });
  });

  it('clamps a timestamp from the future back to now', async () => {
    await pipeline.ingest('traefik', 'http.access', [access({ at: NOW + DAY_MS })], NOW);

    expect(await firstAt(ctx)).toBe(NOW);
  });

  it('clamps a timestamp older than retention forward', async () => {
    await pipeline.ingest('traefik', 'http.access', [access({ at: NOW - 400 * DAY_MS })], NOW);

    expect(await firstAt(ctx)).toBe(NOW - 14 * DAY_MS);
  });

  it('replaces a claimed integration with the caller identity', async () => {
    await pipeline.ingest('traefik', 'http.access', [access({ integration: 'cilium' })], NOW);

    const row = await ctx.db
      .selectFrom('facet_http_access')
      .select('integration')
      .executeTakeFirst();
    expect(row?.integration).toBe('traefik');
  });

  it('truncates an oversized string rather than losing the row', async () => {
    await pipeline.ingest(
      'traefik',
      'http.access',
      [access({ user_agent: 'u'.repeat(9000) })],
      NOW,
    );

    const row = await ctx.db
      .selectFrom('facet_http_access')
      .select('user_agent')
      .executeTakeFirst();
    expect(row?.user_agent?.length).toBe(1024);
  });

  it('stores a batch larger than one insert statement', async () => {
    const rows = Array.from({ length: 1200 }, () => access());

    const report = await pipeline.ingest('traefik', 'http.access', rows, NOW);

    expect(report.accepted).toBe(1200);
    expect(await count(ctx, 'facet_http_access')).toBe(1200);
  });
});

describeEachDialect('IngestPipeline state facets', (ctx) => {
  let pipeline: IngestPipeline;

  beforeEach(async () => {
    await migrateToLatest(ctx.db, ctx.kind);
    pipeline = new IngestPipeline(ctx.db, ctx.sqlHelper);
    await ctx.db.deleteFrom('facet_http_routes').execute();
  });

  it('replaces the previous snapshot for that integration', async () => {
    await pipeline.ingest(
      'traefik',
      'http.routes',
      [route({ name: 'a' }), route({ name: 'b' })],
      NOW,
    );
    await pipeline.ingest('traefik', 'http.routes', [route({ name: 'a' })], NOW);

    const names = await routeNames(ctx);
    expect(names).toEqual(['a']);
  });

  it('leaves another integration untouched', async () => {
    await pipeline.ingest('traefik', 'http.routes', [route({ name: 'from-traefik' })], NOW);
    await pipeline.ingest('nginx', 'http.routes', [route({ name: 'from-nginx' })], NOW);

    await pipeline.ingest('traefik', 'http.routes', [route({ name: 'still-traefik' })], NOW);

    expect(await routeNames(ctx)).toEqual(['from-nginx', 'still-traefik']);
  });

  it('clears an integration when it reports nothing', async () => {
    await pipeline.ingest('traefik', 'http.routes', [route({ name: 'a' })], NOW);

    await pipeline.ingest('traefik', 'http.routes', [], NOW);

    expect(await routeNames(ctx)).toEqual([]);
  });

  /**
   * An unknown facet must be reported before anything is deleted. Handling it
   * after the delete would let a typo or a version mismatch silently wipe a
   * source's snapshot.
   */
  it('does not clear a snapshot when the facet name is unknown', async () => {
    await pipeline.ingest('traefik', 'http.routes', [route({ name: 'a' })], NOW);

    const report = await pipeline.ingest('traefik', 'http.rutes', [route({ name: 'b' })], NOW);

    expect(report.reasons.unknown_facet).toBe(1);
    expect(await routeNames(ctx)).toEqual(['a']);
  });

  it('drops an invalid row but still applies the rest of the snapshot', async () => {
    const report = await pipeline.ingest(
      'traefik',
      'http.routes',
      [route({ name: 'a' }), { observed_at: NOW }, route({ name: 'c' })],
      NOW,
    );

    expect(report.accepted).toBe(2);
    expect(report.dropped).toBe(1);
    expect(await routeNames(ctx)).toEqual(['a', 'c']);
  });
});

async function count(
  ctx: { db: import('kysely').Kysely<import('../db/schema.js').Database> },
  table: 'facet_http_access',
): Promise<number> {
  const row = await ctx.db
    .selectFrom(table)
    .select((eb) => eb.fn.countAll().as('n'))
    .executeTakeFirstOrThrow();
  return Number(row.n);
}

async function firstAt(ctx: {
  db: import('kysely').Kysely<import('../db/schema.js').Database>;
}): Promise<number> {
  const row = await ctx.db.selectFrom('facet_http_access').select('at').executeTakeFirstOrThrow();
  return Number(row.at);
}

async function routeNames(ctx: {
  db: import('kysely').Kysely<import('../db/schema.js').Database>;
}): Promise<string[]> {
  const rows = await ctx.db
    .selectFrom('facet_http_routes')
    .select('name')
    .orderBy('name', 'asc')
    .execute();
  return rows.map((row) => row.name);
}
