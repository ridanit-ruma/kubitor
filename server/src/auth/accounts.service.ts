import { randomBytes } from 'node:crypto';
import type { AccountEventsRepo } from '../db/account-events.repo.js';
import type { Account, AccountsRepo } from '../db/accounts.repo.js';
import type { SessionsRepo } from '../db/sessions.repo.js';
import { hashPassword, verifyPassword } from './password.js';

export interface AccountSummary {
  id: string;
  username: string;
  mustChangePassword: boolean;
  createdAt: number;
}

export type AccountsError = 'reauthentication_failed' | 'username_taken' | 'not_found' | 'self';

export type AccountsResult<T> = { ok: true; value: T } | { ok: false; error: AccountsError };

export interface AccountsDeps {
  accounts: AccountsRepo;
  sessions: SessionsRepo;
  events: AccountEventsRepo;
}

/** A one-time password is shown once and never stored in the clear. */
export function generatePassword(): string {
  return randomBytes(18).toString('base64url');
}

export class AccountsService {
  readonly #deps: AccountsDeps;

  constructor(deps: AccountsDeps) {
    this.#deps = deps;
  }

  async list(): Promise<AccountSummary[]> {
    return (await this.#deps.accounts.list()).map(summarize);
  }

  /**
   * Every mutation re-checks the caller's own password.
   *
   * A stolen session is otherwise enough to create an account and keep access
   * forever; step-up means the attacker also needs the password.
   */
  async #reauthenticate(actor: Account, password: string): Promise<boolean> {
    return verifyPassword(password, actor.passwordHash);
  }

  async create(
    actor: Account,
    actorPassword: string,
    username: string,
    now: number,
  ): Promise<AccountsResult<{ account: AccountSummary; password: string }>> {
    if (!(await this.#reauthenticate(actor, actorPassword))) {
      return { ok: false, error: 'reauthentication_failed' };
    }

    if (await this.#deps.accounts.byUsername(username)) {
      return { ok: false, error: 'username_taken' };
    }

    const password = generatePassword();
    const account = await this.#deps.accounts.create(
      { username, passwordHash: await hashPassword(password), mustChangePassword: true },
      now,
    );

    await this.#deps.events.record({
      at: now,
      actorId: actor.id,
      action: 'create',
      subject: username,
      detail: {},
    });

    return { ok: true, value: { account: summarize(account), password } };
  }

  async resetPassword(
    actor: Account,
    actorPassword: string,
    targetId: string,
    now: number,
  ): Promise<AccountsResult<{ password: string }>> {
    if (!(await this.#reauthenticate(actor, actorPassword))) {
      return { ok: false, error: 'reauthentication_failed' };
    }

    const target = await this.#deps.accounts.byId(targetId);
    if (!target) return { ok: false, error: 'not_found' };

    const password = generatePassword();
    await this.#deps.accounts.setPassword(target.id, await hashPassword(password), true);
    // Whoever held a session under the old password loses it.
    await this.#deps.sessions.deleteForAccount(target.id);

    await this.#deps.events.record({
      at: now,
      actorId: actor.id,
      action: 'reset_password',
      subject: target.username,
      detail: {},
    });

    return { ok: true, value: { password } };
  }

  async delete(
    actor: Account,
    actorPassword: string,
    targetId: string,
    now: number,
  ): Promise<AccountsResult<null>> {
    if (!(await this.#reauthenticate(actor, actorPassword))) {
      return { ok: false, error: 'reauthentication_failed' };
    }

    const target = await this.#deps.accounts.byId(targetId);
    if (!target) return { ok: false, error: 'not_found' };

    /*
     * Refusing self-deletion is also what keeps at least one account alive:
     * deleting someone else requires two accounts to exist, so one always
     * survives. A separate "last account" check would be unreachable.
     */
    if (target.id === actor.id) return { ok: false, error: 'self' };

    await this.#deps.sessions.deleteForAccount(target.id);
    await this.#deps.accounts.delete(target.id);

    await this.#deps.events.record({
      at: now,
      actorId: actor.id,
      action: 'delete',
      subject: target.username,
      detail: {},
    });

    return { ok: true, value: null };
  }

  /**
   * Creates the first account if the database has none. Never touches an
   * existing one, so a restart cannot reset a password that has been changed.
   *
   * Returns the generated password when it had to invent one, so the caller can
   * log it exactly once.
   */
  async bootstrap(
    username: string,
    initialPassword: string | undefined,
    now: number,
  ): Promise<{ created: boolean; generatedPassword?: string }> {
    if ((await this.#deps.accounts.count()) > 0) return { created: false };

    const generated = initialPassword ? undefined : generatePassword();
    const password = initialPassword ?? (generated as string);

    await this.#deps.accounts.create(
      { username, passwordHash: await hashPassword(password), mustChangePassword: true },
      now,
    );

    await this.#deps.events.record({
      at: now,
      actorId: null,
      action: 'create',
      subject: username,
      detail: { by: 'bootstrap' },
    });

    return generated ? { created: true, generatedPassword: generated } : { created: true };
  }
}

function summarize(account: Account): AccountSummary {
  return {
    id: account.id,
    username: account.username,
    mustChangePassword: account.mustChangePassword,
    createdAt: account.createdAt,
  };
}
