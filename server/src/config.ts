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
  })
  .superRefine((value, ctx) => {
    if (value.KUBITOR_DB_KIND === 'postgres' && !value.KUBITOR_POSTGRES_URL) {
      ctx.addIssue({
        code: 'custom',
        path: ['KUBITOR_POSTGRES_URL'],
        message: 'is required when KUBITOR_DB_KIND is postgres',
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
  };
}
