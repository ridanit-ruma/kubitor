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
    // Every reverse proxy sets this one; naming a particular vendor's header
    // here would make every caller look like the ingress controller anywhere
    // that vendor is not in front.
    expect(config.trustedProxyHeader).toBe('x-forwarded-for');
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

  /**
   * `age-keygen` prints two comment lines above the key, so pasting the wrong
   * line is the expected mistake. Caught here it is one line naming the
   * variable; caught later it was an age error naming nothing, thrown from a
   * promise nobody had awaited, which Node answers by ending the process.
   */
  it('rejects a settings key that is not an age identity', () => {
    expect(() =>
      loadConfig(env({ KUBITOR_SETTINGS_KEY: '# created: 2026-09-11T00:00:00Z' })),
    ).toThrow(/KUBITOR_SETTINGS_KEY/);
  });

  it('accepts an age identity as the settings key', () => {
    const key = `AGE-SECRET-KEY-1${'Q'.repeat(43)}`;

    expect(loadConfig(env({ KUBITOR_SETTINGS_KEY: key })).settingsKey).toBe(key);
  });

  /**
   * This value is seeded into the stored document on the first boot that finds
   * none, and the environment is ignored from then on — so an expression that
   * does not parse has to be refused before it is written, not after.
   */
  it('rejects a backup schedule that is not a cron expression', () => {
    expect(() => loadConfig(env({ KUBITOR_BACKUP_SCHEDULE: 'every day at 3' }))).toThrow(
      /KUBITOR_BACKUP_SCHEDULE/,
    );
  });

  it('accepts a five-field backup schedule', () => {
    expect(() => loadConfig(env({ KUBITOR_BACKUP_SCHEDULE: '*/15 * * * *' }))).not.toThrow();
  });
});
