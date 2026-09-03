import { type ColumnDataType, type RawBuilder, sql } from 'kysely';

export type DialectKind = 'sqlite' | 'postgres';

/**
 * The handful of constructs where SQLite and PostgreSQL genuinely diverge.
 * Everything else goes through Kysely unchanged. Members are added by the task
 * that first needs them — time bucketing arrives with the rollup work.
 */
export interface DialectSql {
  readonly kind: DialectKind;
  /** Column type for epoch-millisecond timestamps. */
  timestampMs(): ColumnDataType;
  /** Column type for JSON documents. */
  json(): ColumnDataType;
  /** Extracts a top-level property from a JSON column as text. */
  jsonField(column: string, property: string): RawBuilder<string | null>;
}

export const SQLITE_SQL: DialectSql = {
  kind: 'sqlite',
  timestampMs: () => 'integer',
  json: () => 'text',
  jsonField: (column, property) =>
    sql<string | null>`json_extract(${sql.ref(column)}, ${`$.${property}`})`,
};

export const POSTGRES_SQL: DialectSql = {
  kind: 'postgres',
  timestampMs: () => 'bigint',
  json: () => 'jsonb',
  jsonField: (column, property) => sql<string | null>`${sql.ref(column)} ->> ${property}`,
};

export function sqlFor(kind: DialectKind): DialectSql {
  return kind === 'sqlite' ? SQLITE_SQL : POSTGRES_SQL;
}

/**
 * Reads a JSON column. The PostgreSQL driver parses `jsonb` into objects while
 * SQLite hands back the raw text, so every read goes through here.
 */
export function decodeJson<T>(value: unknown): T {
  return typeof value === 'string' ? (JSON.parse(value) as T) : (value as T);
}
