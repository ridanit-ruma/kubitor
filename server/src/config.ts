import { z } from 'zod';
import type { DbConfig } from './db/connect.js';

/**
 * A session secret shorter than 32 characters is not a key. HS256 truncates or
 * pads whatever it is given, so the check has to live here.
 */
const MIN_SECRET_LENGTH = 32;

const schema = z
  .object({
    PORT: z.coerce.number().int().positive().default(3001),
    KUBITOR_DB_KIND: z.enum(['sqlite', 'postgres']).default('sqlite'),
    KUBITOR_SQLITE_PATH: z.string().min(1).default('/var/lib/kubitor/kubitor.db'),
    KUBITOR_POSTGRES_URL: z.string().min(1).optional(),
    KUBITOR_SESSION_SECRET: z.string().min(MIN_SECRET_LENGTH),
    KUBITOR_SESSION_TTL_HOURS: z.coerce.number().positive().default(12),
    KUBITOR_ADMIN_INITIAL_PASSWORD: z.string().min(1).optional(),
    /**
     * The header carrying the real caller, which throttling and the audit trail
     * key on. Every reverse proxy sets `x-forwarded-for`; a particular one may
     * offer something better — Cloudflare's `cf-connecting-ip` cannot be
     * appended to by a client, where `x-forwarded-for` can — and a deployment
     * behind such a proxy should name it. Defaulting to one vendor's header
     * means every caller looks like the ingress controller everywhere else,
     * which collapses the login throttle onto a single key.
     */
    KUBITOR_TRUSTED_PROXY_HEADER: z.string().min(1).default('x-forwarded-for'),
    KUBITOR_COOKIE_SECURE: z
      .enum(['true', 'false'])
      .default('true')
      .transform((value) => value === 'true'),

    /* Backup. Off entirely unless a bucket is named. */
    KUBITOR_BACKUP_S3_ENDPOINT: z.string().url().optional(),
    KUBITOR_BACKUP_S3_BUCKET: z.string().min(1).optional(),
    KUBITOR_BACKUP_S3_PREFIX: z.string().default(''),
    KUBITOR_BACKUP_S3_ACCESS_KEY: z.string().min(1).optional(),
    KUBITOR_BACKUP_S3_SECRET_KEY: z.string().min(1).optional(),
    /** Providers with no regions still need one in the signature. */
    KUBITOR_BACKUP_S3_REGION: z.string().min(1).default('us-east-1'),
    /**
     * An age recipient. With this and no identity, kubitor writes backups it
     * cannot itself read, which is the point.
     */
    KUBITOR_BACKUP_AGE_RECIPIENT: z.string().min(1).optional(),
    /**
     * The matching identity, optionally.
     *
     * Giving it up is the stronger configuration; keeping it here lets
     * verify-on-write open the restored database rather than only compare bytes.
     */
    KUBITOR_BACKUP_AGE_IDENTITY: z.string().min(1).optional(),
    /**
     * Five-field cron. The odd minute is deliberate: every backup in the world
     * scheduled at `0 3` is a thundering herd on somebody's endpoint.
     */
    KUBITOR_BACKUP_SCHEDULE: z.string().min(1).default('17 3 * * *'),

    /* Notification. Each channel is off unless its address is given. */
    KUBITOR_NOTIFY_DISCORD_WEBHOOK: z.string().url().optional(),
    KUBITOR_NOTIFY_SLACK_WEBHOOK: z.string().url().optional(),
    KUBITOR_NOTIFY_WEBHOOK_URL: z.string().url().optional(),
    KUBITOR_NOTIFY_TELEGRAM_TOKEN: z.string().min(1).optional(),
    /** Not discoverable from the token: talk to the bot, then read getUpdates. */
    KUBITOR_NOTIFY_TELEGRAM_CHAT_ID: z.string().min(1).optional(),
    /**
     * Nothing quieter than this is sent anywhere.
     *
     * `warning` sends everything there is. The floor is one setting rather than
     * one per channel because a routing table is a feature nobody has asked for
     * yet, and the wrong shape is harder to remove than to add.
     */
    KUBITOR_NOTIFY_MIN_SEVERITY: z.enum(['critical', 'warning']).default('warning'),
    /** Where this kubitor is reachable, so a message can link back to it. */
    KUBITOR_PUBLIC_URL: z.string().url().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.KUBITOR_DB_KIND === 'postgres' && !value.KUBITOR_POSTGRES_URL) {
      ctx.addIssue({
        code: 'custom',
        path: ['KUBITOR_POSTGRES_URL'],
        message: 'is required when KUBITOR_DB_KIND is postgres',
      });
    }

    // Half a bucket is the configuration that looks configured and silently
    // never runs, which is the failure this whole feature exists to avoid.
    if (value.KUBITOR_BACKUP_S3_BUCKET) {
      for (const name of [
        'KUBITOR_BACKUP_S3_ENDPOINT',
        'KUBITOR_BACKUP_S3_ACCESS_KEY',
        'KUBITOR_BACKUP_S3_SECRET_KEY',
      ] as const) {
        if (!value[name]) {
          ctx.addIssue({
            code: 'custom',
            path: [name],
            message: 'is required once KUBITOR_BACKUP_S3_BUCKET is set',
          });
        }
      }
    }

    // Half a Telegram configuration sends nothing and says nothing.
    const telegram = [value.KUBITOR_NOTIFY_TELEGRAM_TOKEN, value.KUBITOR_NOTIFY_TELEGRAM_CHAT_ID];
    if (telegram.some(Boolean) && !telegram.every(Boolean)) {
      ctx.addIssue({
        code: 'custom',
        path: ['KUBITOR_NOTIFY_TELEGRAM_CHAT_ID'],
        message: 'both the token and the chat id are needed, or neither',
      });
    }

    if (value.KUBITOR_BACKUP_AGE_IDENTITY && !value.KUBITOR_BACKUP_AGE_RECIPIENT) {
      ctx.addIssue({
        code: 'custom',
        path: ['KUBITOR_BACKUP_AGE_RECIPIENT'],
        message: 'is required alongside KUBITOR_BACKUP_AGE_IDENTITY',
      });
    }
  });

export interface Config {
  port: number;
  db: DbConfig;
  sessionSecret: string;
  sessionTtlMs: number;
  adminInitialPassword?: string;
  /** Header the ingress sets with the real client address. */
  trustedProxyHeader: string;
  cookieSecure: boolean;
  /** Absent unless a bucket is named, which is what turns backups on. */
  backup?: BackupConfig;
  /** Always present; it just may name no channel at all. */
  notify: NotifyConfig;
  /** Where this kubitor is reachable from outside, if it knows. */
  publicUrl?: string;
}

export interface NotifyConfig {
  discordWebhook?: string;
  slackWebhook?: string;
  webhookUrl?: string;
  telegram?: { token: string; chatId: string };
  minimumSeverity: 'critical' | 'warning';
}

export interface BackupConfig {
  endpoint: string;
  bucket: string;
  prefix: string;
  accessKey: string;
  secretKey: string;
  region: string;
  schedule: string;
  ageRecipient?: string;
  ageIdentity?: string;
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const parsed = schema.safeParse(env);

  if (!parsed.success) {
    // Report every problem at once: fixing environment one variable per restart
    // is miserable, especially inside a cluster.
    const lines = parsed.error.issues.map(
      (issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`,
    );
    throw new Error(`Invalid environment:\n${lines.join('\n')}`);
  }

  const value = parsed.data;

  const db: DbConfig =
    value.KUBITOR_DB_KIND === 'sqlite'
      ? { kind: 'sqlite', sqlitePath: value.KUBITOR_SQLITE_PATH }
      : { kind: 'postgres', postgresUrl: value.KUBITOR_POSTGRES_URL as string };

  return {
    port: value.PORT,
    db,
    sessionSecret: value.KUBITOR_SESSION_SECRET,
    sessionTtlMs: value.KUBITOR_SESSION_TTL_HOURS * 60 * 60 * 1000,
    ...(value.KUBITOR_ADMIN_INITIAL_PASSWORD
      ? { adminInitialPassword: value.KUBITOR_ADMIN_INITIAL_PASSWORD }
      : {}),
    trustedProxyHeader: value.KUBITOR_TRUSTED_PROXY_HEADER,
    cookieSecure: value.KUBITOR_COOKIE_SECURE,
    notify: {
      ...(value.KUBITOR_NOTIFY_DISCORD_WEBHOOK
        ? { discordWebhook: value.KUBITOR_NOTIFY_DISCORD_WEBHOOK }
        : {}),
      ...(value.KUBITOR_NOTIFY_SLACK_WEBHOOK
        ? { slackWebhook: value.KUBITOR_NOTIFY_SLACK_WEBHOOK }
        : {}),
      ...(value.KUBITOR_NOTIFY_WEBHOOK_URL ? { webhookUrl: value.KUBITOR_NOTIFY_WEBHOOK_URL } : {}),
      ...(value.KUBITOR_NOTIFY_TELEGRAM_TOKEN && value.KUBITOR_NOTIFY_TELEGRAM_CHAT_ID
        ? {
            telegram: {
              token: value.KUBITOR_NOTIFY_TELEGRAM_TOKEN,
              chatId: value.KUBITOR_NOTIFY_TELEGRAM_CHAT_ID,
            },
          }
        : {}),
      minimumSeverity: value.KUBITOR_NOTIFY_MIN_SEVERITY,
    },
    ...(value.KUBITOR_PUBLIC_URL ? { publicUrl: value.KUBITOR_PUBLIC_URL } : {}),
    ...(value.KUBITOR_BACKUP_S3_BUCKET
      ? {
          backup: {
            endpoint: value.KUBITOR_BACKUP_S3_ENDPOINT as string,
            bucket: value.KUBITOR_BACKUP_S3_BUCKET,
            prefix: value.KUBITOR_BACKUP_S3_PREFIX,
            accessKey: value.KUBITOR_BACKUP_S3_ACCESS_KEY as string,
            secretKey: value.KUBITOR_BACKUP_S3_SECRET_KEY as string,
            region: value.KUBITOR_BACKUP_S3_REGION,
            schedule: value.KUBITOR_BACKUP_SCHEDULE,
            ...(value.KUBITOR_BACKUP_AGE_RECIPIENT
              ? { ageRecipient: value.KUBITOR_BACKUP_AGE_RECIPIENT }
              : {}),
            ...(value.KUBITOR_BACKUP_AGE_IDENTITY
              ? { ageIdentity: value.KUBITOR_BACKUP_AGE_IDENTITY }
              : {}),
          },
        }
      : {}),
  };
}
