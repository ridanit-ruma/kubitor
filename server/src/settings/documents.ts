import { z } from 'zod';
import { isCronExpression } from '../backup/cron.js';
import { SEALED } from './secrets.js';

/** The keys these two documents live under in the `settings` table. */
export const NOTIFY_KEY = 'notify';
export const BACKUP_KEY = 'backup';

/**
 * Five-field cron. The odd minute is deliberate: every backup in the world
 * scheduled at `0 3` is a thundering herd on somebody's endpoint.
 */
export const DEFAULT_SCHEDULE = '17 3 * * *';

const SEVERITY = z.enum(['critical', 'warning']);

/**
 * Where alerts go.
 *
 * `version` is a literal rather than a number so a future shape is a new
 * literal and an old server refuses to read it, instead of half-reading it and
 * silently dropping the channels it does not recognise.
 *
 * A channel is present or absent as a whole. Half a Telegram configuration
 * sends nothing and says nothing, which is the failure this feature exists to
 * make visible, so the schema does not permit it.
 */
export const NOTIFY_DOCUMENT = z.object({
  version: z.literal(1),
  minimumSeverity: SEVERITY,
  discord: z.object({ webhookUrl: SEALED }).optional(),
  slack: z.object({ webhookUrl: SEALED }).optional(),
  webhook: z.object({ url: SEALED }).optional(),
  telegram: z.object({ token: SEALED, chatId: z.string().min(1) }).optional(),
  ntfy: z
    .object({ server: z.string().url(), topic: z.string().min(1), token: SEALED.optional() })
    .optional(),
  gotify: z.object({ server: z.string().url(), token: SEALED }).optional(),
  smtp: z.object({ url: SEALED, from: z.string().min(1), to: z.string().min(1) }).optional(),
});

export type NotifyDocument = z.infer<typeof NOTIFY_DOCUMENT>;

/**
 * Where the database goes, and when.
 *
 * `schedule` sits outside `destination` because it is meaningful without one —
 * an operator sets the hour before they have the bucket, and clearing the
 * bucket should not silently reset it.
 *
 * `accessKey` is not sealed. An S3 access key id is an identifier, like a
 * username; the secret key is the credential. Sealing an identifier would cost
 * the ability to tell two buckets apart in a dump and buy nothing.
 *
 * `ageRecipient` is a public half and is likewise stored readably. The matching
 * identity stays in the environment: see the spec.
 *
 * `schedule` is parsed on the way in as well as on the way out. The write path
 * has always refused an expression that does not parse; without the same check
 * here, one that reached the row by any other route — seeded from an older
 * environment, edited by hand — made the scheduler's constructor throw during
 * boot, and the environment could no longer be edited to take it back. Refusing
 * the document instead falls to `EMPTY_BACKUP`: backups off, logged once, and a
 * server that starts.
 */
export const BACKUP_DOCUMENT = z.object({
  version: z.literal(1),
  schedule: z.string().min(1).refine(isCronExpression, 'is not a five-field cron expression'),
  ageRecipient: z.string().min(1).optional(),
  destination: z
    .object({
      endpoint: z.string().url(),
      bucket: z.string().min(1),
      prefix: z.string(),
      region: z.string().min(1),
      accessKey: z.string().min(1),
      secretKey: SEALED,
    })
    .optional(),
});

export type BackupDocument = z.infer<typeof BACKUP_DOCUMENT>;

export const EMPTY_NOTIFY: NotifyDocument = { version: 1, minimumSeverity: 'warning' };
export const EMPTY_BACKUP: BackupDocument = { version: 1, schedule: DEFAULT_SCHEDULE };

/**
 * A stored document, or nothing at all.
 *
 * Returning `undefined` rather than throwing is the whole point: the caller
 * treats an unreadable document as absent and starts anyway. It must not then
 * overwrite the row — a document nobody can read is still somebody's
 * configuration, and destroying it is not a recovery.
 */
export function parseNotify(
  raw: unknown,
  log?: (message: string) => void,
): NotifyDocument | undefined {
  return parse(NOTIFY_DOCUMENT, raw, NOTIFY_KEY, log);
}

export function parseBackup(
  raw: unknown,
  log?: (message: string) => void,
): BackupDocument | undefined {
  return parse(BACKUP_DOCUMENT, raw, BACKUP_KEY, log);
}

function parse<T>(
  schema: z.ZodType<T>,
  raw: unknown,
  key: string,
  log?: (message: string) => void,
): T | undefined {
  const parsed = schema.safeParse(raw);
  if (parsed.success) return parsed.data;

  const problems = parsed.error.issues
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
  log?.(`The stored "${key}" settings could not be read and are being ignored: ${problems}`);

  return undefined;
}
