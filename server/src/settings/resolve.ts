import type { BackupConfig, NotifyConfig } from '../config.js';
import type { BackupDocument, NotifyDocument } from './documents.js';
import type { Sealed, Sealer } from './secrets.js';

/**
 * A stored document as the runtime already wants it.
 *
 * The target types are the ones `channelsFrom` and `BackupRunner` have always
 * taken. Keeping them means everything downstream of here is unchanged by this
 * feature, and the environment and the database produce the same object.
 */
export async function resolveNotify(
  document: NotifyDocument,
  sealer: Sealer,
  log?: (message: string) => void,
): Promise<NotifyConfig> {
  const open = opener(sealer, log);

  const [discord, slack, webhook, telegram, ntfyToken, gotify, smtp] = await Promise.all([
    open(document.discord?.webhookUrl, 'discord.webhookUrl'),
    open(document.slack?.webhookUrl, 'slack.webhookUrl'),
    open(document.webhook?.url, 'webhook.url'),
    open(document.telegram?.token, 'telegram.token'),
    open(document.ntfy?.token, 'ntfy.token'),
    open(document.gotify?.token, 'gotify.token'),
    open(document.smtp?.url, 'smtp.url'),
  ]);

  return {
    ...(discord ? { discordWebhook: discord } : {}),
    ...(slack ? { slackWebhook: slack } : {}),
    ...(webhook ? { webhookUrl: webhook } : {}),
    ...(telegram && document.telegram
      ? { telegram: { token: telegram, chatId: document.telegram.chatId } }
      : {}),
    ...(document.ntfy
      ? {
          ntfy: {
            server: document.ntfy.server,
            topic: document.ntfy.topic,
            ...(ntfyToken ? { token: ntfyToken } : {}),
          },
        }
      : {}),
    ...(gotify && document.gotify
      ? { gotify: { server: document.gotify.server, token: gotify } }
      : {}),
    ...(smtp && document.smtp
      ? { smtp: { url: smtp, from: document.smtp.from, to: document.smtp.to } }
      : {}),
    minimumSeverity: document.minimumSeverity,
  };
}

/**
 * The destination, or nothing.
 *
 * `ageIdentity` comes from the caller rather than the document because it is
 * the one backup value that stays in the environment: it decrypts the backup
 * that would be used to restore the database it would otherwise live in.
 */
export async function resolveBackup(
  document: BackupDocument,
  sealer: Sealer,
  ageIdentity: string | undefined,
  log?: (message: string) => void,
): Promise<BackupConfig | null> {
  const destination = document.destination;
  if (!destination) return null;

  const secretKey = await opener(sealer, log)(destination.secretKey, 'backup.secretKey');
  if (!secretKey) return null;

  return {
    endpoint: destination.endpoint,
    bucket: destination.bucket,
    prefix: destination.prefix,
    accessKey: destination.accessKey,
    secretKey,
    region: destination.region,
    schedule: document.schedule,
    ...(document.ageRecipient ? { ageRecipient: document.ageRecipient } : {}),
    ...(ageIdentity ? { ageIdentity } : {}),
  };
}

/**
 * Opening one field, where failing to open it is not fatal.
 *
 * A rotated or missing `KUBITOR_SETTINGS_KEY` must cost the channel it locked
 * and nothing else. The log line is what turns a silent absence into something
 * an operator can act on.
 */
function opener(
  sealer: Sealer,
  log?: (message: string) => void,
): (sealed: Sealed | undefined, field: string) => Promise<string | undefined> {
  return async (sealed, field) => {
    if (!sealed) return undefined;

    try {
      return await sealer.open(sealed);
    } catch (error) {
      log?.(`Settings field "${field}" could not be decrypted and is being ignored: ${String(error)}`);
      return undefined;
    }
  };
}
