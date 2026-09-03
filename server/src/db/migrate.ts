import type { Kysely } from 'kysely';
import { Migrator } from 'kysely/migration';
import { type DialectKind, sqlFor } from './dialect.js';
import { createMigrations } from './migrations/index.js';
import type { Database } from './schema.js';

export async function migrateToLatest(db: Kysely<Database>, kind: DialectKind): Promise<void> {
  const migrations = createMigrations(sqlFor(kind));

  const migrator = new Migrator({
    db,
    provider: { getMigrations: async () => migrations },
  });

  const { error, results } = await migrator.migrateToLatest();

  for (const result of results ?? []) {
    if (result.status === 'Error') {
      throw new Error(`Migration ${result.migrationName} failed`, { cause: error });
    }
  }

  if (error) {
    throw new Error('Migration failed', { cause: error });
  }
}
