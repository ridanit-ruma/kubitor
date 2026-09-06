import { beforeEach, expect, it } from 'vitest';
import { AlertsRepo } from '../db/alerts.repo.js';
import { BackupsRepo } from '../db/backups.repo.js';
import { migrateToLatest } from '../db/migrate.js';
import { IngestPipeline } from '../plugins/ingest.js';
import { describeEachDialect } from '../test/db-harness.js';
import { AlertsService } from './service.js';

const NOW = 1_756_800_000_000;

describeEachDialect('AlertsService', (ctx) => {
  let alerts: AlertsRepo;
  let pipeline: IngestPipeline;

  beforeEach(async () => {
    await migrateToLatest(ctx.db, ctx.kind);
    await ctx.db.deleteFrom('alerts').execute();
    await ctx.db.deleteFrom('backups').execute();
    await ctx.db.deleteFrom('facet_nodes').execute();
    await ctx.db.deleteFrom('facet_workloads').execute();

    alerts = new AlertsRepo(ctx.db, ctx.sqlHelper);
    pipeline = new IngestPipeline(ctx.db, ctx.sqlHelper);
  });

  function service(overrides: { stale?: string[]; backups?: BackupsRepo | null } = {}) {
    return new AlertsService({
      db: ctx.db,
      alerts,
      backups: overrides.backups === undefined ? null : overrides.backups,
      staleAgents: async () => overrides.stale ?? [],
      now: () => NOW,
    });
  }

  async function node(name: string, ready: number) {
    await pipeline.ingest(
      'core',
      'nodes',
      [
        {
          observed_at: NOW,
          name,
          roles: '',
          ready,
          kubelet_version: 'v1.36.3',
          os_image: 'NixOS',
          architecture: 'amd64',
          capacity_cpu_milli: 12_000,
          capacity_memory_bytes: 1,
          capacity_pods: 110,
          allocatable_cpu_milli: 12_000,
          allocatable_memory_bytes: 1,
          allocatable_pods: 110,
          created_at: NOW,
        },
      ],
      NOW,
    );
  }

  it('reads the cluster and fires once the condition has held', async () => {
    await node('ken', 0);
    const alerting = service();

    expect(await alerting.evaluateOnce()).toEqual([]);
    const second = await alerting.evaluateOnce();

    expect(second.map((t) => t.alert.rule)).toEqual(['node-not-ready']);
    expect((await alerting.firing())[0]?.subject).toBe('ken');
  });

  it('says nothing about a healthy cluster', async () => {
    await node('ken', 1);
    const alerting = service();

    await alerting.evaluateOnce();
    expect(await alerting.evaluateOnce()).toEqual([]);
    expect(await alerting.firing()).toEqual([]);
  });

  it('fires on the first failed backup, which is the rule that needs no wait', async () => {
    const backups = new BackupsRepo(ctx.db);
    const id = await backups.start(NOW);
    await backups.finish(id, NOW + 1000, { ok: false, error: 'S3 answered 403: AccessDenied' });

    const transitions = await service({ backups }).evaluateOnce();

    expect(transitions.map((t) => t.alert.rule)).toEqual(['backup-failed']);
    expect(transitions[0]?.alert.detail).toContain('AccessDenied');
  });

  it('says nothing when the last backup worked', async () => {
    const backups = new BackupsRepo(ctx.db);
    const id = await backups.start(NOW);
    await backups.finish(id, NOW + 1000, { ok: true, verified: true, key: 'k', bytes: 1 });

    expect(await service({ backups }).evaluateOnce()).toEqual([]);
  });

  it('notices an agent that stopped reporting', async () => {
    const alerting = service({ stale: ['buildbox'] });

    await alerting.evaluateOnce();
    const transitions = await alerting.evaluateOnce();

    expect(transitions.map((t) => t.alert.subject)).toEqual(['buildbox']);
  });

  /**
   * Losing the timer would end every future evaluation silently, which is the
   * failure this whole subsystem exists to prevent happening elsewhere.
   */
  it('survives a rule that throws', async () => {
    const alerting = new AlertsService({
      db: ctx.db,
      alerts,
      backups: null,
      staleAgents: async () => {
        throw new Error('cache unavailable');
      },
      now: () => NOW,
      rules: [],
    });

    await expect(alerting.evaluateOnce()).resolves.toEqual([]);
  });

  it('hands transitions to whoever is listening, for delivery to consume later', async () => {
    const seen: string[] = [];
    const alerting = new AlertsService({
      db: ctx.db,
      alerts,
      backups: null,
      staleAgents: async () => ['buildbox'],
      now: () => NOW,
      onTransitions: (transitions) => seen.push(...transitions.map((t) => t.kind)),
    });

    await alerting.evaluateOnce();
    await alerting.evaluateOnce();

    expect(seen).toEqual(['fired']);
  });
});
