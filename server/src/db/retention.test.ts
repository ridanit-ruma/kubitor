import { sql } from 'kysely';
import { beforeAll, expect, it } from 'vitest';
import { describeEachDialect } from '../test/db-harness.js';
import { migrateToLatest } from './migrate.js';
import { sweepRetention } from './retention.js';
import type { TableSpec } from './tables.js';

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
});
