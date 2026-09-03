import { expect, it } from 'vitest';
import { describeEachDialect, listOwnTables } from '../test/db-harness.js';
import { migrateToLatest } from './migrate.js';
import { MIGRATION_BOOKKEEPING_TABLES, TABLES } from './tables.js';

it('gives every event table a time column and a retention window', () => {
  for (const spec of TABLES) {
    if (spec.kind !== 'event') continue;
    expect(spec.timeColumn, `${spec.name} has no time column`).toBeTruthy();
    expect(spec.retentionMs, `${spec.name} has no retention window`).toBeGreaterThan(0);
  }
});

it('does not put a retention window on a table that never grows', () => {
  for (const spec of TABLES) {
    if (spec.kind === 'event') continue;
    expect(spec.retentionMs, `${spec.name} is not an event table`).toBeUndefined();
  }
});

describeEachDialect('table registry', (ctx) => {
  it('registers every table the migrations create', async () => {
    await migrateToLatest(ctx.db, ctx.kind);

    const bookkeeping = new Set<string>(MIGRATION_BOOKKEEPING_TABLES);
    const created = (await listOwnTables(ctx)).filter((name) => !bookkeeping.has(name));
    const registered = new Set(TABLES.map((t) => t.name));

    for (const name of created) {
      expect(registered.has(name), `table ${name} exists but is not in TABLES`).toBe(true);
    }
  });

  it('creates every table the registry claims', async () => {
    await migrateToLatest(ctx.db, ctx.kind);

    const created = new Set(await listOwnTables(ctx));
    for (const spec of TABLES) {
      expect(created.has(spec.name), `table ${spec.name} is registered but was never created`).toBe(
        true,
      );
    }
  });
});
