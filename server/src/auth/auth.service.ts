import { setTimeout as delay } from 'node:timers/promises';
import type { AccountEventsRepo } from '../db/account-events.repo.js';
import type { Account, AccountsRepo } from '../db/accounts.repo.js';
import type { LoginAttemptsRepo } from '../db/login-attempts.repo.js';
import type { Session, SessionsRepo } from '../db/sessions.repo.js';
import { decideLogin, FAILED_LOGIN_DELAY_MS, lockoutWindowStart } from './login-policy.js';
import { hashPassword, verifyPassword } from './password.js';

/**
 * A hash of a value nobody knows, verified against when the username does not
 * exist so an unknown user costs the same work as a wrong password. Without it,
 * response time tells an attacker which usernames are real.
 */
let dummyHashPromise: Promise<string> | undefined;
function dummyHash(): Promise<string> {
  dummyHashPromise ??= hashPassword('kubitor-nonexistent-account-placeholder');
  return dummyHashPromise;
}

export type LoginResult =
  | { ok: true; session: Session; account: Account }
  | { ok: false; reason: 'invalid' }
  | { ok: false; reason: 'locked'; retryAfterMs: number };

export interface ValidatedSession {
  session: Session;
  account: Account;
}

export interface AuthDeps {
  accounts: AccountsRepo;
  sessions: SessionsRepo;
  attempts: LoginAttemptsRepo;
  events: AccountEventsRepo;
  sessionTtlMs: number;
  /** Overridable so tests are not paced by the anti-enumeration delay. */
  failedLoginDelayMs?: number;
}

export class AuthService {
  readonly #deps: AuthDeps;
  readonly #failedLoginDelayMs: number;

  constructor(deps: AuthDeps) {
    this.#deps = deps;
    this.#failedLoginDelayMs = deps.failedLoginDelayMs ?? FAILED_LOGIN_DELAY_MS;
  }

  #pause(): Promise<void> {
    return delay(this.#failedLoginDelayMs);
  }

  async login(username: string, password: string, ip: string, now: number): Promise<LoginResult> {
    const { accounts, sessions, attempts, events, sessionTtlMs } = this.#deps;

    const failures = await attempts.recentFailuresByIp(ip, lockoutWindowStart(now));
    const decision = decideLogin(failures);
    if (!decision.allowed) {
      await attempts.record(now, ip, username, 'locked');
      await this.#pause();
      return { ok: false, reason: 'locked', retryAfterMs: decision.retryAfterMs ?? 0 };
    }

    const account = await accounts.byUsername(username);

    // Always run a verification, even with no account, so the two paths cost
    // the same.
    const stored = account?.passwordHash ?? (await dummyHash());
    const matches = await verifyPassword(password, stored);

    if (!account || !matches || account.disabledAt !== null) {
      await attempts.record(now, ip, username, account ? 'bad_password' : 'unknown_user');
      await this.#pause();
      return { ok: false, reason: 'invalid' };
    }

    await attempts.record(now, ip, username, 'ok');
    const session = await sessions.create(account.id, sessionTtlMs, now);
    await events.record({
      at: now,
      actorId: account.id,
      action: 'login',
      subject: account.username,
      detail: { ip },
    });

    return { ok: true, session, account };
  }

  async logout(sid: string, now: number): Promise<void> {
    const { sessions, accounts, events } = this.#deps;

    const session = await sessions.byId(sid);
    if (!session) return;

    await sessions.delete(sid);

    const account = await accounts.byId(session.accountId);
    if (account) {
      await events.record({
        at: now,
        actorId: account.id,
        action: 'logout',
        subject: account.username,
        detail: {},
      });
    }
  }

  /** Returns null for an unknown, expired or orphaned session. */
  async validate(sid: string, now: number): Promise<ValidatedSession | null> {
    const { sessions, accounts } = this.#deps;

    const session = await sessions.byId(sid);
    if (!session) return null;

    if (session.expiresAt <= now) {
      await sessions.delete(sid);
      return null;
    }

    const account = await accounts.byId(session.accountId);
    if (!account || account.disabledAt !== null) {
      await sessions.delete(sid);
      return null;
    }

    await sessions.touch(sid, now);
    return { session, account };
  }

  /**
   * Changing a password revokes every other session: if the reason for the
   * change was a leak, leaving the leaked sessions alive defeats the point.
   */
  async changePassword(
    accountId: string,
    current: string,
    next: string,
    keepSessionId: string,
    now: number,
  ): Promise<boolean> {
    const { accounts, sessions, events } = this.#deps;

    const account = await accounts.byId(accountId);
    if (!account) return false;
    if (!(await verifyPassword(current, account.passwordHash))) {
      await this.#pause();
      return false;
    }

    await accounts.setPassword(account.id, await hashPassword(next), false);
    await sessions.deleteForAccount(account.id, keepSessionId);
    await events.record({
      at: now,
      actorId: account.id,
      action: 'change_password',
      subject: account.username,
      detail: {},
    });

    return true;
  }
}
