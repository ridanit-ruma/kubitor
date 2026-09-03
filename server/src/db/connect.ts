import { DatabaseSync } from 'node:sqlite';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import type { DialectKind } from './dialect.js';
import type { Database } from './schema.js';
import { NodeSqliteDialect } from './sqlite-dialect.js';

export interface DbConfig {
  kind: DialectKind;
  /** Required when kind is 'sqlite'. */
  sqlitePath?: string;
  /** Required when kind is 'postgres'. */
  postgresUrl?: string;
  /**
   * Optional PostgreSQL schema to resolve unqualified names against. Tests use
   * it to give each suite the isolation a private SQLite file gives for free.
   */
  postgresSchema?: string;
}

export function createDb(config: DbConfig): Kysely<Database> {
  if (config.kind === 'sqlite') {
    if (!config.sqlitePath) throw new Error('sqlitePath is required for the sqlite dialect');
    return new Kysely<Database>({
      dialect: new NodeSqliteDialect({ database: new DatabaseSync(config.sqlitePath) }),
    });
  }

  if (!config.postgresUrl) throw new Error('postgresUrl is required for the postgres dialect');

  if (config.postgresSchema && !/^[a-z_][a-z0-9_]*$/.test(config.postgresSchema)) {
    // The schema name reaches the server as a startup option rather than a
    // bound parameter, so it is validated instead of escaped.
    throw new Error(`Invalid postgresSchema: ${config.postgresSchema}`);
  }

  return new Kysely<Database>({
    dialect: new PostgresDialect({
      // One connection pool, kept small: kubitor runs a single replica and
      // predictable memory matters more than throughput here.
      pool: new pg.Pool({
        connectionString: config.postgresUrl,
        max: 4,
        ...(config.postgresSchema ? { options: `-c search_path=${config.postgresSchema}` } : {}),
      }),
    }),
  });
}
