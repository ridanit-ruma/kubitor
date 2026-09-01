import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import {
  CompiledQuery,
  type DatabaseConnection,
  type DatabaseIntrospector,
  type Dialect,
  type DialectAdapter,
  type Driver,
  type Kysely,
  type QueryCompiler,
  type QueryResult,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
} from 'kysely';

export interface NodeSqliteDialectConfig {
  database: DatabaseSync;
}

/**
 * Kysely dialect backed by Node's built-in `node:sqlite`.
 *
 * Using the runtime's own SQLite keeps kubitor free of native dependencies:
 * no compiler in the build image, no install scripts to allow, no prebuilt
 * binaries to match against the runtime.
 */
export class NodeSqliteDialect implements Dialect {
  readonly #config: NodeSqliteDialectConfig;

  constructor(config: NodeSqliteDialectConfig) {
    this.#config = config;
  }

  createAdapter(): DialectAdapter {
    return new SqliteAdapter();
  }

  createDriver(): Driver {
    return new NodeSqliteDriver(this.#config.database);
  }

  createQueryCompiler(): QueryCompiler {
    return new SqliteQueryCompiler();
  }

  createIntrospector(db: Kysely<unknown>): DatabaseIntrospector {
    return new SqliteIntrospector(db);
  }
}

class NodeSqliteDriver implements Driver {
  readonly #database: DatabaseSync;
  readonly #releasers = new WeakMap<DatabaseConnection, () => void>();
  #queue: Promise<void> = Promise.resolve();

  constructor(database: DatabaseSync) {
    this.#database = database;
  }

  async init(): Promise<void> {
    this.#database.exec('PRAGMA journal_mode = WAL');
    this.#database.exec('PRAGMA foreign_keys = ON');
    this.#database.exec('PRAGMA busy_timeout = 5000');
  }

  /**
   * `node:sqlite` exposes a single synchronous handle, so two overlapping
   * transactions would interleave their BEGIN/COMMIT. Hand out access in turn.
   */
  async acquireConnection(): Promise<DatabaseConnection> {
    const previous = this.#queue;
    let release!: () => void;
    this.#queue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;

    const connection = new NodeSqliteConnection(this.#database);
    this.#releasers.set(connection, release);
    return connection;
  }

  async releaseConnection(connection: DatabaseConnection): Promise<void> {
    this.#releasers.get(connection)?.();
    this.#releasers.delete(connection);
  }

  async beginTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw('BEGIN'));
  }

  async commitTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw('COMMIT'));
  }

  async rollbackTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw('ROLLBACK'));
  }

  async destroy(): Promise<void> {
    this.#database.close();
  }
}

class NodeSqliteConnection implements DatabaseConnection {
  readonly #database: DatabaseSync;

  constructor(database: DatabaseSync) {
    this.#database = database;
  }

  async executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
    const statement = this.#database.prepare(compiled.sql);
    const parameters = compiled.parameters.map(toSqliteValue);

    // An empty column list means the statement produces no rows, and `run()` is
    // the only call that reports how many rows it changed. This holds for raw
    // SQL as well, so transaction control flows through the same path.
    if (statement.columns().length === 0) {
      const { changes, lastInsertRowid } = statement.run(...parameters);
      return {
        numAffectedRows: BigInt(changes),
        insertId: BigInt(lastInsertRowid),
        rows: [],
      };
    }

    return { rows: statement.all(...parameters) as R[] };
  }

  /**
   * Streaming is not offered. node:sqlite is synchronous and holds a single
   * handle, so a long-lived cursor would block every other query. Nothing in
   * kubitor streams from SQLite; large exports page instead.
   */
  streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
    throw new Error('The node:sqlite dialect does not support streaming');
  }
}

/** node:sqlite binds only null, number, bigint, string, Uint8Array. */
function toSqliteValue(value: unknown): SQLInputValue {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value === undefined || value === null) return null;
  if (value instanceof Date) return value.getTime();
  return value as SQLInputValue;
}
