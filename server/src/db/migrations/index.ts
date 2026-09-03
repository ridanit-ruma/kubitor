import type { Migration } from 'kysely/migration';
import type { DialectSql } from '../dialect.js';
import { settingsMigration } from './0001-settings.js';

/**
 * One ordered chain for both dialects. Keys sort lexicographically and are the
 * migration's identity — never rename or renumber one that has shipped.
 */
export function createMigrations(dialect: DialectSql): Record<string, Migration> {
  return {
    '0001-settings': settingsMigration(dialect),
  };
}
