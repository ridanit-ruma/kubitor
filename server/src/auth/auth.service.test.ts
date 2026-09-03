import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountEventsRepo } from '../db/account-events.repo.js';
import { AccountsRepo } from '../db/accounts.repo.js';
import { LoginAttemptsRepo } from '../db/login-attempts.repo.js';
import { migrateToLatest } from '../db/migrate.js';
import { SessionsRepo } from '../db/sessions.repo.js';
import { describeEachDialect } from '../test/db-harness.js';
import { AuthService } from './auth.service.js';
import { LOCKOUT } from './login-policy.js';
import { hashPassword } from './password.js';

// Spy on verification so the timing-parity rule can be asserted structurally
// rather than by measuring a wall clock on a loaded machine.
const { verifySpy } = vi.hoisted(() => ({ verifySpy: vi.fn() }));

vi.mock('./password.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./password.js')>();
  return {
    ...actual,
    verifyPassword: (plain: string, stored: string) => {
      verifySpy(plain, stored);
      return actual.verifyPassword(plain, stored);
    },
  };
});

const NOW = 1_756_800_000_000;
const TTL = 3_600_000;
const IP = '203.0.113.9';

describeEachDialect('AuthService', (ctx) => {
  let auth: AuthService;
  let accounts: AccountsRepo;
  let sessions: SessionsRepo;
  let attempts: LoginAttemptsRepo;
  let password: string;

  beforeAll(async () => {
    await migrateToLatest(ctx.db, ctx.kind);
    accounts = new AccountsRepo(ctx.db);
    sessions = new SessionsRepo(ctx.db);
    attempts = new LoginAttemptsRepo(ctx.db);

    auth = new AuthService({
      accounts,
      sessions,
      attempts,
      events: new AccountEventsRepo(ctx.db, ctx.sqlHelper),
      sessionTtlMs: TTL,
      failedLoginDelayMs: 0,
    });

    password = 'a-good-password';
    await accounts.create(
      { username: 'admin', passwordHash: await hashPassword(password), mustChangePassword: true },
      NOW,
    );
  });

  beforeEach(async () => {
    verifySpy.mockClear();
    await ctx.db.deleteFrom('login_attempts').execute();
  });

  describe('login', () => {
    it('issues a session for the right password', async () => {
      const result = await auth.login('admin', password, IP, NOW);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.account.username).toBe('admin');
      expect(await sessions.byId(result.session.id)).toBeDefined();
    });

    it('rejects the wrong password and records the failure', async () => {
      const result = await auth.login('admin', 'wrong', IP, NOW);

      expect(result).toEqual({ ok: false, reason: 'invalid' });
      expect(await attempts.recentFailuresByIp(IP, NOW - 1000)).toBe(1);
    });

    it('rejects an unknown username with the same answer as a wrong password', async () => {
      const unknown = await auth.login('nobody', password, IP, NOW);

      expect(unknown).toEqual({ ok: false, reason: 'invalid' });
    });

    /**
     * The anti-enumeration property: an unknown username must still perform a
     * verification, otherwise it returns measurably faster than a wrong
     * password and the response reveals which usernames exist.
     */
    it('verifies a dummy hash when the username does not exist', async () => {
      await auth.login('nobody', password, IP, NOW);

      expect(verifySpy).toHaveBeenCalledTimes(1);
      expect(verifySpy.mock.calls[0]?.[1]).toMatch(/^scrypt\$/);
    });

    it('locks the address out after the threshold and reports a retry delay', async () => {
      for (let i = 0; i < LOCKOUT.threshold; i += 1) {
        await auth.login('admin', 'wrong', IP, NOW);
      }

      const result = await auth.login('admin', password, IP, NOW);

      expect(result).toEqual({
        ok: false,
        reason: 'locked',
        retryAfterMs: LOCKOUT.cooldownMs,
      });
    });

    it('locks the address, not the account, so another address still works', async () => {
      for (let i = 0; i < LOCKOUT.threshold; i += 1) {
        await auth.login('admin', 'wrong', IP, NOW);
      }

      const elsewhere = await auth.login('admin', password, '198.51.100.4', NOW);

      expect(elsewhere.ok).toBe(true);
    });

    it('ignores failures older than the lockout window', async () => {
      for (let i = 0; i < LOCKOUT.threshold; i += 1) {
        await auth.login('admin', 'wrong', IP, NOW - LOCKOUT.windowMs - 1000);
      }

      expect((await auth.login('admin', password, IP, NOW)).ok).toBe(true);
    });
  });

  describe('validate', () => {
    it('accepts a live session and marks it seen', async () => {
      const login = await auth.login('admin', password, IP, NOW);
      if (!login.ok) throw new Error('login failed');

      const validated = await auth.validate(login.session.id, NOW + 1000);

      expect(validated?.account.username).toBe('admin');
      expect((await sessions.byId(login.session.id))?.lastSeenAt).toBe(NOW + 1000);
    });

    it('rejects and deletes an expired session', async () => {
      const login = await auth.login('admin', password, IP, NOW);
      if (!login.ok) throw new Error('login failed');

      expect(await auth.validate(login.session.id, NOW + TTL + 1)).toBeNull();
      expect(await sessions.byId(login.session.id)).toBeUndefined();
    });

    it('rejects an unknown session id', async () => {
      expect(await auth.validate('does-not-exist', NOW)).toBeNull();
    });
  });

  describe('logout', () => {
    it('deletes the session', async () => {
      const login = await auth.login('admin', password, IP, NOW);
      if (!login.ok) throw new Error('login failed');

      await auth.logout(login.session.id, NOW);

      expect(await sessions.byId(login.session.id)).toBeUndefined();
    });

    it('is silent about a session that is already gone', async () => {
      await expect(auth.logout('does-not-exist', NOW)).resolves.toBeUndefined();
    });
  });

  describe('changePassword', () => {
    it('refuses without the current password', async () => {
      const account = await accounts.byUsername('admin');
      if (!account) throw new Error('missing account');

      expect(await auth.changePassword(account.id, 'wrong', 'whatever', '', NOW)).toBe(false);
    });

    it('sets the new password, clears the must-change flag and revokes other sessions', async () => {
      const first = await auth.login('admin', password, IP, NOW);
      const second = await auth.login('admin', password, IP, NOW);
      if (!first.ok || !second.ok) throw new Error('login failed');

      const next = 'an-even-better-password';
      const changed = await auth.changePassword(
        first.account.id,
        password,
        next,
        first.session.id,
        NOW,
      );
      password = next;

      expect(changed).toBe(true);
      expect((await accounts.byUsername('admin'))?.mustChangePassword).toBe(false);
      expect(await sessions.byId(first.session.id)).toBeDefined();
      expect(await sessions.byId(second.session.id)).toBeUndefined();
      expect((await auth.login('admin', next, IP, NOW)).ok).toBe(true);
    });
  });
});
