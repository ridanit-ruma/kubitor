import type { BackupView, NotifyView } from '@kubitor/shared';
import { type BackupInput, type NotifyInput, SECRET_KEPT } from '@kubitor/shared';
import { z } from 'zod';
import { parseCron } from '../backup/cron.js';
import {
  BACKUP_DOCUMENT,
  type BackupDocument,
  NOTIFY_DOCUMENT,
  type NotifyDocument,
} from './documents.js';
import { type Sealed, type Sealer, SettingsKeyMissing } from './secrets.js';

/** A body that parsed but cannot be stored. The field is what the form marks. */
export class SettingsInvalid extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.name = 'SettingsInvalid';
    this.field = field;
  }
}

const SECRET = z.string().nullable();

export const NOTIFY_INPUT = z.object({
  minimumSeverity: z.enum(['critical', 'warning']),
  discord: z.object({ webhookUrl: SECRET }),
  slack: z.object({ webhookUrl: SECRET }),
  webhook: z.object({ url: SECRET }),
  telegram: z.object({ token: SECRET, chatId: z.string() }),
  ntfy: z.object({ server: z.string(), topic: z.string(), token: SECRET }),
  gotify: z.object({ server: z.string(), token: SECRET }),
  smtp: z.object({ url: SECRET, from: z.string(), to: z.string() }),
});

export const BACKUP_INPUT = z.object({
  schedule: z.string(),
  ageRecipient: z.string(),
  destination: z.object({
    endpoint: z.string(),
    bucket: z.string(),
    prefix: z.string(),
    region: z.string(),
    accessKey: z.string(),
    secretKey: SECRET,
  }),
});

/** `SECRET_KEPT` where there is one, `null` where there is not. Never the value. */
function shown(sealed: Sealed | undefined): string | null {
  return sealed === undefined ? null : SECRET_KEPT;
}

export function toNotifyView(document: NotifyDocument, canStoreSecrets: boolean): NotifyView {
  return {
    minimumSeverity: document.minimumSeverity,
    discord: { webhookUrl: shown(document.discord?.webhookUrl) },
    slack: { webhookUrl: shown(document.slack?.webhookUrl) },
    webhook: { url: shown(document.webhook?.url) },
    telegram: { token: shown(document.telegram?.token), chatId: document.telegram?.chatId ?? '' },
    ntfy: {
      server: document.ntfy?.server ?? '',
      topic: document.ntfy?.topic ?? '',
      token: shown(document.ntfy?.token),
    },
    gotify: { server: document.gotify?.server ?? '', token: shown(document.gotify?.token) },
    smtp: {
      url: shown(document.smtp?.url),
      from: document.smtp?.from ?? '',
      to: document.smtp?.to ?? '',
    },
    canStoreSecrets,
  };
}

export function toBackupView(document: BackupDocument, canStoreSecrets: boolean): BackupView {
  return {
    schedule: document.schedule,
    ageRecipient: document.ageRecipient ?? '',
    destination: {
      endpoint: document.destination?.endpoint ?? '',
      bucket: document.destination?.bucket ?? '',
      prefix: document.destination?.prefix ?? '',
      region: document.destination?.region ?? '',
      accessKey: document.destination?.accessKey ?? '',
      secretKey: shown(document.destination?.secretKey),
    },
    canStoreSecrets,
  };
}

interface SecretOutcome {
  value: Sealed | undefined;
  changed: boolean;
}

/**
 * One secret field, given what arrived and what is stored.
 *
 * Whether it changed is decided by what the caller sent, never by comparing
 * ciphertext: age is randomized, so the same value seals differently every time
 * and a byte comparison would report every save as a change.
 */
async function sealField(
  input: string | null,
  current: Sealed | undefined,
  sealer: Sealer,
): Promise<SecretOutcome> {
  if (input === SECRET_KEPT) return { value: current, changed: false };
  if (input === null || input === '') return { value: undefined, changed: current !== undefined };
  if (!sealer.canSeal) throw new SettingsKeyMissing();

  return { value: await sealer.seal(input), changed: true };
}

/** A plain field, and whether it moved. */
function plainField(input: string, current: string | undefined, changed: string[], name: string) {
  if (input !== (current ?? '')) changed.push(name);
  return input;
}

/**
 * A webhook address that is not a URL fails silently at 3am, and the failure
 * surfaces as an error string carrying the address back to whoever asked. Refuse
 * it at save time instead, which is also what the test button exists to make
 * unnecessary.
 */
function requireUrl(value: string | null, field: string): void {
  if (value === null || value === '' || value === SECRET_KEPT) return;
  try {
    new URL(value);
  } catch {
    throw new SettingsInvalid(field, 'must be a URL');
  }
}

export async function mergeNotify(
  input: NotifyInput,
  current: NotifyDocument,
  sealer: Sealer,
): Promise<{ document: NotifyDocument; changed: string[] }> {
  // Checked on the plaintext, before anything is sealed: these four values are
  // handed to `fetch` or nodemailer as a URL, and a value that fails to parse
  // there comes back in an error string a caller can read — the same string
  // `GET` redacts everywhere else.
  requireUrl(input.discord.webhookUrl, 'discord.webhookUrl');
  requireUrl(input.slack.webhookUrl, 'slack.webhookUrl');
  requireUrl(input.webhook.url, 'webhook.url');
  requireUrl(input.smtp.url, 'smtp.url');

  const changed: string[] = [];

  const note = (name: string, outcome: SecretOutcome): Sealed | undefined => {
    if (outcome.changed) changed.push(name);
    return outcome.value;
  };

  const [discord, slack, webhook, telegram, ntfyToken, gotify, smtp] = await Promise.all([
    sealField(input.discord.webhookUrl, current.discord?.webhookUrl, sealer),
    sealField(input.slack.webhookUrl, current.slack?.webhookUrl, sealer),
    sealField(input.webhook.url, current.webhook?.url, sealer),
    sealField(input.telegram.token, current.telegram?.token, sealer),
    sealField(input.ntfy.token, current.ntfy?.token, sealer),
    sealField(input.gotify.token, current.gotify?.token, sealer),
    sealField(input.smtp.url, current.smtp?.url, sealer),
  ]);

  const discordValue = note('discord.webhookUrl', discord);
  const slackValue = note('slack.webhookUrl', slack);
  const webhookValue = note('webhook.url', webhook);
  const telegramToken = note('telegram.token', telegram);
  const ntfyTokenValue = note('ntfy.token', ntfyToken);
  const gotifyToken = note('gotify.token', gotify);
  const smtpUrl = note('smtp.url', smtp);

  const chatId = plainField(
    input.telegram.chatId,
    current.telegram?.chatId,
    changed,
    'telegram.chatId',
  );
  const ntfyServer = plainField(input.ntfy.server, current.ntfy?.server, changed, 'ntfy.server');
  const ntfyTopic = plainField(input.ntfy.topic, current.ntfy?.topic, changed, 'ntfy.topic');
  const gotifyServer = plainField(
    input.gotify.server,
    current.gotify?.server,
    changed,
    'gotify.server',
  );
  const smtpFrom = plainField(input.smtp.from, current.smtp?.from, changed, 'smtp.from');
  const smtpTo = plainField(input.smtp.to, current.smtp?.to, changed, 'smtp.to');

  if (input.minimumSeverity !== current.minimumSeverity) changed.push('minimumSeverity');

  // Built loosely and validated once. A channel is included whenever any of its
  // fields was given, so an incomplete one is a 400 that names the missing
  // field rather than a save that quietly drops the channel.
  const candidate: Record<string, unknown> = {
    version: 1,
    minimumSeverity: input.minimumSeverity,
    ...(discordValue ? { discord: { webhookUrl: discordValue } } : {}),
    ...(slackValue ? { slack: { webhookUrl: slackValue } } : {}),
    ...(webhookValue ? { webhook: { url: webhookValue } } : {}),
    ...(telegramToken || chatId ? { telegram: { token: telegramToken, chatId } } : {}),
    ...(ntfyServer || ntfyTopic || ntfyTokenValue
      ? {
          ntfy: {
            server: ntfyServer,
            topic: ntfyTopic,
            ...(ntfyTokenValue ? { token: ntfyTokenValue } : {}),
          },
        }
      : {}),
    ...(gotifyServer || gotifyToken
      ? { gotify: { server: gotifyServer, token: gotifyToken } }
      : {}),
    ...(smtpUrl || smtpFrom || smtpTo
      ? { smtp: { url: smtpUrl, from: smtpFrom, to: smtpTo } }
      : {}),
  };

  return { document: validate(NOTIFY_DOCUMENT, candidate), changed };
}

export async function mergeBackup(
  input: BackupInput,
  current: BackupDocument,
  sealer: Sealer,
): Promise<{ document: BackupDocument; changed: string[] }> {
  const changed: string[] = [];

  // A schedule that does not parse would leave the scheduler armed on nothing,
  // which looks exactly like a working backup that never runs.
  try {
    parseCron(input.schedule);
  } catch (error) {
    throw new SettingsInvalid('schedule', `is not a five-field cron expression: ${String(error)}`);
  }

  const secretKey = await sealField(
    input.destination.secretKey,
    current.destination?.secretKey,
    sealer,
  );
  if (secretKey.changed) changed.push('destination.secretKey');

  const destination = input.destination;
  const stored = current.destination;
  const endpoint = plainField(
    destination.endpoint,
    stored?.endpoint,
    changed,
    'destination.endpoint',
  );
  const bucket = plainField(destination.bucket, stored?.bucket, changed, 'destination.bucket');
  const prefix = plainField(destination.prefix, stored?.prefix, changed, 'destination.prefix');
  const region = plainField(destination.region, stored?.region, changed, 'destination.region');
  const accessKey = plainField(
    destination.accessKey,
    stored?.accessKey,
    changed,
    'destination.accessKey',
  );

  if (input.schedule !== current.schedule) changed.push('schedule');
  if (input.ageRecipient !== (current.ageRecipient ?? '')) changed.push('ageRecipient');

  // The bucket is the one identifying field of a destination — as with a
  // single-field channel like discord's webhookUrl, its presence decides
  // whether the destination is on. Three cases:
  //  - bucket given: the destination is named; validate it as a unit, so a
  //    half-filled one becomes a 400 naming what is missing rather than a
  //    save that quietly runs against the wrong endpoint.
  //  - bucket empty, a destination was stored: a deliberate clear; drop it.
  //  - bucket empty, nothing stored: if some other field was given anyway,
  //    name the destination regardless, so `BACKUP_DOCUMENT`'s
  //    `bucket: z.string().min(1)` rejects it with `field: 'destination.bucket'`
  //    instead of silently discarding the other fields while `changed` still
  //    lists them as if they had been stored.
  const named = bucket
    ? true
    : stored !== undefined
      ? false
      : Boolean(endpoint || region || accessKey || secretKey.value);

  const candidate: Record<string, unknown> = {
    version: 1,
    schedule: input.schedule,
    ...(input.ageRecipient ? { ageRecipient: input.ageRecipient } : {}),
    ...(named
      ? {
          destination: {
            endpoint,
            bucket,
            prefix,
            region,
            accessKey,
            secretKey: secretKey.value,
          },
        }
      : {}),
  };

  return { document: validate(BACKUP_DOCUMENT, candidate), changed };
}

function validate<T>(schema: z.ZodType<T>, candidate: unknown): T {
  const parsed = schema.safeParse(candidate);
  if (parsed.success) return parsed.data;

  const issue = parsed.error.issues[0];
  throw new SettingsInvalid(issue?.path.join('.') ?? '(root)', issue?.message ?? 'is not valid');
}
