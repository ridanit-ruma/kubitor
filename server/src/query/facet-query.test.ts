import { beforeEach, expect, it } from 'vitest';
import { migrateToLatest } from '../db/migrate.js';
import { IngestPipeline } from '../plugins/ingest.js';
import { describeEachDialect } from '../test/db-harness.js';
import { FacetQuery } from './facet-query.js';

const NOW = 1_756_800_000_000;

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

describeEachDialect('FacetQuery filtering', (ctx) => {
  let query: FacetQuery;

  beforeEach(async () => {
    await migrateToLatest(ctx.db, ctx.kind);
    await ctx.db.deleteFrom('facet_http_access').execute();

    await new IngestPipeline(ctx.db, ctx.sqlHelper).ingest(
      'traefik',
      'http.access',
      [
        access({ host: 'kubitor.example', path: '/api/metrics/current' }),
        access({ host: 'kubitor.example', path: '/nodes/calder' }),
        access({ host: 'shop.example', path: '/checkout' }),
        access({ host: 'blog.example', path: '/posts/1' }),
      ],
      NOW,
    );

    query = new FacetQuery(ctx.db, ctx.sqlHelper);
  });

  it('finds rows matching a search term', async () => {
    const page = await query.run('http.access', { search: 'checkout' });
    expect(page.total).toBe(1);
    expect(page.rows[0]?.path).toBe('/checkout');
  });

  /**
   * The counterpart to search, and the reason it exists: kubitor's own
   * dashboard is by volume the loudest thing in a cluster's access log, and the
   * useful question is "everything except that".
   */
  it('hides rows matching an exclusion', async () => {
    const page = await query.run('http.access', { exclude: 'kubitor.example' });

    expect(page.total).toBe(2);
    expect(page.rows.map((row) => row.host).sort()).toEqual(['blog.example', 'shop.example']);
  });

  it('applies search and exclusion together', async () => {
    const page = await query.run('http.access', { search: 'example', exclude: 'shop' });
    expect(page.total).toBe(3);
  });

  it('counts what it returns, so the total matches the exclusion', async () => {
    const page = await query.run('http.access', { exclude: 'example' });
    expect(page.total).toBe(0);
    expect(page.rows).toHaveLength(0);
  });

  it('treats an empty exclusion as no exclusion', async () => {
    const page = await query.run('http.access', { exclude: '   ' });
    expect(page.total).toBe(4);
  });

  it('takes wildcards in an exclusion literally', async () => {
    // `%` is a LIKE wildcard; a reader typing it means the character.
    const page = await query.run('http.access', { exclude: '%' });
    expect(page.total).toBe(4);
  });

  it('exports the same rows the screen shows', async () => {
    const filters = { exclude: 'kubitor.example' };
    const page = await query.run('http.access', filters);

    const streamed: Record<string, unknown>[] = [];
    for await (const row of query.stream('http.access', filters, 1000)) streamed.push(row);

    expect(streamed).toHaveLength(page.total);
  });
});
