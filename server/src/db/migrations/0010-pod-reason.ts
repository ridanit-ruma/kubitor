import type { Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';
import type { DialectSql } from '../dialect.js';

/**
 * Why a pod is not running, in the words Kubernetes uses.
 *
 * `phase` is too coarse to act on: a pod stuck in `CrashLoopBackOff` and one
 * waiting on an image pull are both `Pending`, and the operator's next step is
 * completely different. The reason comes from the container that is not
 * running — which is what `kubectl get pods` puts in its STATUS column.
 */
export function podReasonMigration(_dialect: DialectSql): Migration {
  return {
    async up(db: Kysely<unknown>): Promise<void> {
      await db.schema.alterTable('facet_workloads').addColumn('reason', 'text').execute();
    },

    async down(db: Kysely<unknown>): Promise<void> {
      await db.schema.alterTable('facet_workloads').dropColumn('reason').execute();
    },
  };
}
