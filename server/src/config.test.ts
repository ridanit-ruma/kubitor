import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

const SECRET = 'x'.repeat(32);

function env(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    KUBITOR_SESSION_SECRET: SECRET,
    KUBITOR_SQLITE_PATH: '/var/lib/kubitor/kubitor.db',
    ...overrides,
  } as NodeJS.ProcessEnv;
}

describe('loadConfig', () => {
  it('applies defaults', () => {
    const config = loadConfig(env());

    expect(config.port).toBe(3001);
    expect(config.db.kind).toBe('sqlite');
    expect(config.sessionTtlMs).toBe(12 * 60 * 60 * 1000);
    expect(config.trustedProxyHeader).toBe('cf-connecting-ip');
    expect(config.cookieSecure).toBe(true);
  });

  it('rejects a session secret that is too short to be a key', () => {
    expect(() => loadConfig(env({ KUBITOR_SESSION_SECRET: 'short' }))).toThrow(
      /KUBITOR_SESSION_SECRET/,
    );
  });

  it('rejects a missing session secret', () => {
    expect(() => loadConfig(env({ KUBITOR_SESSION_SECRET: undefined }))).toThrow(
      /KUBITOR_SESSION_SECRET/,
    );
  });

  it('requires a url when the dialect is postgres', () => {
    expect(() => loadConfig(env({ KUBITOR_DB_KIND: 'postgres' }))).toThrow(/KUBITOR_POSTGRES_URL/);
  });

  it('accepts postgres with a url', () => {
    const config = loadConfig(
      env({ KUBITOR_DB_KIND: 'postgres', KUBITOR_POSTGRES_URL: 'postgres://h/db' }),
    );

    expect(config.db).toEqual({ kind: 'postgres', postgresUrl: 'postgres://h/db' });
  });

  it('reports every problem at once rather than one at a time', () => {
    const broken = loadConfig.bind(null, {
      KUBITOR_SESSION_SECRET: 'short',
      KUBITOR_DB_KIND: 'postgres',
    } as NodeJS.ProcessEnv);

    expect(broken).toThrow(/KUBITOR_SESSION_SECRET[\s\S]*KUBITOR_POSTGRES_URL/);
  });

  it('allows an insecure cookie for local http development', () => {
    expect(loadConfig(env({ KUBITOR_COOKIE_SECURE: 'false' })).cookieSecure).toBe(false);
  });

  it('reads the session lifetime in hours', () => {
    expect(loadConfig(env({ KUBITOR_SESSION_TTL_HOURS: '4' })).sessionTtlMs).toBe(
      4 * 60 * 60 * 1000,
    );
  });
});
