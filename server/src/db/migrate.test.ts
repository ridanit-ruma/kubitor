import { expect, it } from 'vitest';
import { describeEachDialect, listOwnTables } from '../test/db-harness.js';
import { migrateToLatest } from './migrate.js';

describeEachDialect('migrateToLatest', (ctx) => {
  it('creates the settings table', async () => {
    await migrateToLatest(ctx.db, ctx.kind);

    expect(await listOwnTables(ctx)).toContain('settings');
  });

  it('is idempotent', async () => {
    await migrateToLatest(ctx.db, ctx.kind);
    await expect(migrateToLatest(ctx.db, ctx.kind)).resolves.toBeUndefined();
  });

  it('stores and reads back an epoch-millisecond timestamp without loss', async () => {
    await migrateToLatest(ctx.db, ctx.kind);
    const at = 1_756_800_000_123;

    await ctx.db
      .insertInto('settings')
      .values({ key: 'probe', value: '{"a":1}', updated_at: at })
      .execute();

    const row = await ctx.db
      .selectFrom('settings')
      .selectAll()
      .where('key', '=', 'probe')
      .executeTakeFirstOrThrow();

    // PostgreSQL returns bigint columns as strings; this documents that
    // boundary rather than hiding it behind a schema change.
    expect(Number(row.updated_at)).toBe(at);
  });
});
