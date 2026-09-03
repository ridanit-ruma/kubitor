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
  /** Column type for counts that exceed 32 bits, such as byte totals. */
  bigInt(): ColumnDataType;
  /** Column type for JSON documents. */
  json(): ColumnDataType;
  /** Extracts a top-level property from a JSON column as text. */
  jsonField(column: string, property: string): RawBuilder<string | null>;
  /** Encodes a value for writing into a JSON column. */
  encodeJson(value: unknown): string;
  /**
   * Decodes a JSON column as this dialect's driver returns it.
   *
   * Whether a value needs parsing is a property of the dialect, never of the
   * value: node-postgres parses `jsonb` itself, so a stored JSON string comes
   * back as a plain JS string that must not be parsed again.
   */
  decodeJson<T>(value: unknown): T;
}

export const SQLITE_SQL: DialectSql = {
  kind: 'sqlite',
  timestampMs: () => 'integer',
  bigInt: () => 'integer',
  json: () => 'text',
  jsonField: (column, property) =>
    sql<string | null>`json_extract(${sql.ref(column)}, ${`$.${property}`})`,
  encodeJson: (value) => JSON.stringify(value),
  decodeJson: <T>(value: unknown): T => JSON.parse(value as string) as T,
};

export const POSTGRES_SQL: DialectSql = {
  kind: 'postgres',
  timestampMs: () => 'bigint',
  bigInt: () => 'bigint',
  json: () => 'jsonb',
  jsonField: (column, property) => sql<string | null>`${sql.ref(column)} ->> ${property}`,
  encodeJson: (value) => JSON.stringify(value),
  decodeJson: <T>(value: unknown): T => value as T,
};

export function sqlFor(kind: DialectKind): DialectSql {
  return kind === 'sqlite' ? SQLITE_SQL : POSTGRES_SQL;
}
