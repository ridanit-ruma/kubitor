import { beforeEach, expect, it, vi } from 'vitest';
import { migrateToLatest } from '../db/migrate.js';
import type { Collector, IntegrationModule } from '../plugins/contract.js';
import { IngestPipeline } from '../plugins/ingest.js';
import { describeEachDialect } from '../test/db-harness.js';
import { fakeProbes } from '../test/fake-probes.js';
import { CollectorScheduler } from './scheduler.js';

const NOW = 1_756_800_000_000;

function moduleWith(id: string, collectors: Collector[]): IntegrationModule {
  return {
    id,
    title: id,
    scope: 'cluster',
    facets: ['http.access'],
    requiredRbac: [],
    detect: async () => ({ state: 'present', evidence: 'test' }),
    collectors: () => collectors,
  };
}

function accessRow(): Record<string, unknown> {
  return {
    at: NOW,
    host: 'kubitor.example',
    method: 'GET',
    path: '/',
    status: 200,
    duration_ms: 1,
    client_ip: '198.51.100.1',
  };
}

describeEachDialect('CollectorScheduler', (ctx) => {
  let scheduler: CollectorScheduler;
  let errors: string[];

  beforeEach(async () => {
    await migrateToLatest(ctx.db, ctx.kind);
    await ctx.db.deleteFrom('facet_http_access').execute();

    errors = [];
    scheduler = new CollectorScheduler({
      pipeline: new IngestPipeline(ctx.db, ctx.sqlHelper),
      probes: fakeProbes(),
      now: () => NOW,
      onError: (id) => errors.push(id),
    });
  });

  it('stores what a collector emits', async () => {
    const collector = {
      kind: 'poll',
      id: 'good',
      intervalMs: 60_000,
      run: async () => [{ facet: 'http.access' as const, rows: [accessRow()] }],
    } satisfies Collector;

    await scheduler.runOnce('traefik', collector);

    const rows = await ctx.db.selectFrom('facet_http_access').selectAll().execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.integration).toBe('traefik');
  });

  /**
   * An unreachable kubelet must not cost the cluster its workload list. One
   * broken collector should cost only its own screens.
   */
  it('reports a failing collector without stopping the others', async () => {
    const broken = {
      kind: 'poll',
      id: 'broken',
      intervalMs: 60_000,
      run: async () => {
        throw new Error('kubelet unreachable');
      },
    } satisfies Collector;
    const working = {
      kind: 'poll',
      id: 'working',
      intervalMs: 60_000,
      run: async () => [{ facet: 'http.access' as const, rows: [accessRow()] }],
    } satisfies Collector;

    await scheduler.runOnce('core', broken);
    await scheduler.runOnce('core', working);

    expect(errors).toEqual(['broken']);
    expect(await ctx.db.selectFrom('facet_http_access').selectAll().execute()).toHaveLength(1);
  });

  it('runs every poll collector once as soon as it starts', async () => {
    const run = vi.fn(async () => []);
    const module = moduleWith('traefik', [
      { kind: 'poll', id: 'a', intervalMs: 60_000, run },
      { kind: 'push', id: 'b', facet: 'http.access' },
    ]);

    scheduler.start([module]);
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));

    scheduler.stop();
  });

  it('does nothing more once stopped', async () => {
    const run = vi.fn(async () => []);
    scheduler.stop();

    await scheduler.runOnce('traefik', { kind: 'poll', id: 'a', intervalMs: 1000, run });

    expect(run).not.toHaveBeenCalled();
  });
});
