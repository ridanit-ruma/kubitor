import type { Migration } from 'kysely/migration';
import type { DialectSql } from '../dialect.js';
import { settingsMigration } from './0001-settings.js';
import { authMigration } from './0002-auth.js';
import { facetsMigration } from './0003-facets.js';

/**
 * One ordered chain for both dialects. Keys sort lexicographically and are the
 * migration's identity — never rename or renumber one that has shipped.
 */
export function createMigrations(dialect: DialectSql): Record<string, Migration> {
  return {
    '0001-settings': settingsMigration(dialect),
    '0002-auth': authMigration(dialect),
    '0003-facets': facetsMigration(dialect),
  };
}
