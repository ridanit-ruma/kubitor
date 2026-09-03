import { beforeAll, expect, it } from 'vitest';
import { describeEachDialect } from '../test/db-harness.js';
import { migrateToLatest } from './migrate.js';
import { SettingsRepo } from './settings.repo.js';

describeEachDialect('SettingsRepo', (ctx) => {
  let repo: SettingsRepo;

  beforeAll(async () => {
    await migrateToLatest(ctx.db, ctx.kind);
    repo = new SettingsRepo(ctx.db, ctx.sqlHelper);
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

  /**
   * Scalars are the case that broke first: PostgreSQL stores them in `jsonb`
   * and its driver hands them back already parsed, so a decoder that branched
   * on the value's runtime type tried to parse them a second time.
   */
  it('round-trips scalar values of every JSON type', async () => {
    await repo.set('a-string', 'manual', 1_756_800_000_000);
    await repo.set('a-number', 42, 1_756_800_000_000);
    await repo.set('a-boolean', false, 1_756_800_000_000);
    await repo.set('a-null', null, 1_756_800_000_000);

    expect(await repo.get('a-string')).toBe('manual');
    expect(await repo.get('a-number')).toBe(42);
    expect(await repo.get('a-boolean')).toBe(false);
    expect(await repo.get('a-null')).toBeNull();
  });

  it('lists every stored key', async () => {
    await repo.set('a', 1, 1_756_800_000_000);
    await repo.set('b', [true, null], 1_756_800_000_000);

    const all = await repo.all();
    expect(all.a).toBe(1);
    expect(all.b).toEqual([true, null]);
  });
});
