import { beforeAll, expect, it } from 'vitest';
import { describeEachDialect } from '../test/db-harness.js';
import { migrateToLatest } from './migrate.js';
import { SettingsRepo } from './settings.repo.js';

describeEachDialect('SettingsRepo', (ctx) => {
  let repo: SettingsRepo;

  beforeAll(async () => {
    await migrateToLatest(ctx.db, ctx.kind);
    repo = new SettingsRepo(ctx.db);
  });

  it('returns undefined for a key that was never set', async () => {
    expect(await repo.get('missing')).toBeUndefined();
  });

  it('round-trips a structured value', async () => {
    await repo.set('retention', { events: 14, alerts: 90 }, 1_756_800_000_000);

    expect(await repo.get<{ events: number; alerts: number }>('retention')).toEqual({
      events: 14,
      alerts: 90,
    });
  });

  it('overwrites an existing key rather than failing on the primary key', async () => {
    await repo.set('mode', 'auto', 1_756_800_000_000);
    await repo.set('mode', 'manual', 1_756_800_001_000);

    expect(await repo.get('mode')).toBe('manual');
  });

  it('lists every stored key', async () => {
    await repo.set('a', 1, 1_756_800_000_000);
    await repo.set('b', [true, null], 1_756_800_000_000);

    const all = await repo.all();
    expect(all.a).toBe(1);
    expect(all.b).toEqual([true, null]);
  });
});
