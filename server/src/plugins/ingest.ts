import type { Kysely } from 'kysely';
import type { DialectSql } from '../db/dialect.js';
import type { Database } from '../db/schema.js';
import { type FacetDescriptor, facetDescriptor, MAX_TEXT } from './facets.js';

export interface IngestReport {
  accepted: number;
  dropped: number;
  /** Why rows were dropped, so a broken collector is visible rather than silent. */
  reasons: Record<string, number>;
}

/** How far back an inbound timestamp may claim to be, per facet kind. */
const DEFAULT_CLAMP_WINDOW_MS = 14 * 86_400_000;

/**
 * The single funnel every collector's output passes through.
 *
 * The rule this class exists to enforce: **sanitize and keep, never reject a
 * batch**. A malformed row drops itself and nothing else, and the call still
 * succeeds. Rejecting the batch would wedge the sender's buffer permanently,
 * and anyone able to reach the ingest endpoint could trigger it on purpose.
 */
export class IngestPipeline {
  readonly #db: Kysely<Database>;
  readonly #sql: DialectSql;

  constructor(db: Kysely<Database>, dialect: DialectSql) {
    this.#db = db;
    this.#sql = dialect;
  }

  async ingest(
    integration: string,
    facet: string,
    rows: readonly unknown[],
    now: number,
  ): Promise<IngestReport> {
    const report: IngestReport = { accepted: 0, dropped: 0, reasons: {} };

    const descriptor = facetDescriptor(facet);
    if (!descriptor) {
      // A newer collector talking to an older server, or a typo. Report it;
      // never throw, or one unknown facet stops everything else in the batch.
      return drop(report, 'unknown_facet', rows.length);
    }

    const prepared: Record<string, unknown>[] = [];
    for (const row of rows) {
      const validated = this.#prepare(descriptor, row, integration, now);
      if (validated) prepared.push(validated);
      else drop(report, 'invalid_row', 1);
    }

    if (descriptor.kind === 'event') {
      await this.#insert(descriptor, prepared);
    } else {
      await this.#replaceSnapshot(descriptor, integration, prepared);
    }

    report.accepted = prepared.length;
    return report;
  }

  #prepare(
    descriptor: FacetDescriptor,
    row: unknown,
    integration: string,
    now: number,
  ): Record<string, unknown> | null {
    const truncated = truncateStrings(row);
    const parsed = descriptor.schema.safeParse(truncated);
    if (!parsed.success) return null;

    const value: Record<string, unknown> = { ...parsed.data };

    // The caller's identity wins. A row claiming to come from another
    // integration would otherwise let one source overwrite another's snapshot.
    value.integration = integration;

    const window = descriptor.retentionMs ?? DEFAULT_CLAMP_WINDOW_MS;
    value[descriptor.timeColumn] = clamp(Number(value[descriptor.timeColumn]), now - window, now);

    for (const column of descriptor.jsonColumns) {
      value[column] = this.#sql.encodeJson(value[column] ?? {});
    }

    // Zod leaves optional keys absent; the column list must be complete.
    return value;
  }

  async #insert(descriptor: FacetDescriptor, rows: Record<string, unknown>[]): Promise<void> {
    if (rows.length === 0) return;

    // Chunked so one enormous batch cannot exceed a statement's parameter
    // limit, which PostgreSQL enforces at 65535.
    for (const chunk of chunks(rows, 500)) {
      await this.#db
        .insertInto(descriptor.table as keyof Database)
        // biome-ignore lint/suspicious/noExplicitAny: table is chosen by descriptor
        .values(chunk as any)
        .execute();
    }
  }

  /**
   * A snapshot is authoritative for the integration that sent it: everything
   * that source previously reported is replaced, so rows that disappeared
   * upstream disappear here. Other integrations are untouched.
   */
  async #replaceSnapshot(
    descriptor: FacetDescriptor,
    integration: string,
    rows: Record<string, unknown>[],
  ): Promise<void> {
    await this.#db.transaction().execute(async (trx) => {
      await trx
        .deleteFrom(descriptor.table as keyof Database)
        // biome-ignore lint/suspicious/noExplicitAny: table is chosen by descriptor
        .where('integration' as any, '=', integration)
        .execute();

      for (const chunk of chunks(rows, 500)) {
        await trx
          .insertInto(descriptor.table as keyof Database)
          // biome-ignore lint/suspicious/noExplicitAny: table is chosen by descriptor
          .values(chunk as any)
          .execute();
      }
    });
  }
}

function drop(report: IngestReport, reason: string, count: number): IngestReport {
  report.dropped += count;
  report.reasons[reason] = (report.reasons[reason] ?? 0) + count;
  return report;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return max;
  return Math.min(Math.max(Math.trunc(value), min), max);
}

/**
 * Long strings are shortened rather than rejected. A 4 KB user-agent is still
 * a real request, and dropping it would lose the request entirely.
 */
function truncateStrings(row: unknown): unknown {
  if (typeof row !== 'object' || row === null) return row;

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row as Record<string, unknown>)) {
    result[key] =
      typeof value === 'string' && value.length > MAX_TEXT ? value.slice(0, MAX_TEXT) : value;
  }
  return result;
}

function* chunks<T>(items: readonly T[], size: number): Generator<T[]> {
  for (let index = 0; index < items.length; index += size) {
    yield items.slice(index, index + size);
  }
}
