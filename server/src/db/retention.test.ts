import { sql } from 'kysely';
import { beforeAll, expect, it } from 'vitest';
import { describeEachDialect } from '../test/db-harness.js';
import { migrateToLatest } from './migrate.js';
import { sweepRetention } from './retention.js';
import { TABLES, type TableSpec } from './tables.js';

const NOW = 1_756_800_000_000;
const DAY_MS = 86_400_000;

const SPECS: readonly TableSpec[] = [
  { name: 'sweep_probe', kind: 'event', timeColumn: 'at', retentionMs: 7 * DAY_MS },
  { name: 'settings', kind: 'config' },
];

describeEachDialect('sweepRetention', (ctx) => {
  beforeAll(async () => {
    await migrateToLatest(ctx.db, ctx.kind);
    await sql`CREATE TABLE sweep_probe (at ${sql.raw(ctx.sqlHelper.timestampMs())} NOT NULL)`.execute(
      ctx.db,
    );
    await sql`INSERT INTO sweep_probe (at) VALUES
      (${NOW - 8 * DAY_MS}), (${NOW - 30 * DAY_MS}), (${NOW - DAY_MS}), (${NOW})`.execute(ctx.db);
  });

  it('deletes rows past the retention window and keeps the rest', async () => {
    const deleted = await sweepRetention(ctx.db, SPECS, NOW);

    expect(deleted.sweep_probe).toBe(2);

    const remaining = await sql<{ c: number }>`SELECT count(*) AS c FROM sweep_probe`.execute(
      ctx.db,
    );
    expect(Number(remaining.rows[0]?.c)).toBe(2);
  });

  it('leaves tables that are not event tables alone', async () => {
    const deleted = await sweepRetention(ctx.db, SPECS, NOW);
    expect(deleted.settings).toBeUndefined();
  });

  /**
   * Sweeping the real registry proves each spec's `timeColumn` matches the
   * column the migration actually created — a mismatch would otherwise only
   * surface as a table that silently never prunes.
   */
  it('sweeps every registered event table without error', async () => {
    await ctx.db
      .insertInto('login_attempts')
      .values({ at: NOW - 2 * DAY_MS, ip: '10.0.0.1', username: 'a', outcome: 'bad_password' })
      .execute();
    await ctx.db
      .insertInto('account_events')
      .values({
        at: NOW - 200 * DAY_MS,
        actor_id: null,
        action: 'login',
        subject: 'a',
        detail: ctx.sqlHelper.encodeJson({}),
      })
      .execute();

    const deleted = await sweepRetention(ctx.db, TABLES, NOW);

    expect(deleted.login_attempts).toBe(1);
    expect(deleted.account_events).toBe(1);
    for (const spec of TABLES) {
      if (spec.kind === 'event') expect(deleted[spec.name]).toBeGreaterThanOrEqual(0);
    }
  });
});
