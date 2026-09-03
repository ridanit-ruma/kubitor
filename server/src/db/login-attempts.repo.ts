import type { Kysely } from 'kysely';
import type { Database, LoginOutcome } from './schema.js';

export class LoginAttemptsRepo {
  readonly #db: Kysely<Database>;

  constructor(db: Kysely<Database>) {
    this.#db = db;
  }

  async record(at: number, ip: string, username: string, outcome: LoginOutcome): Promise<void> {
    await this.#db.insertInto('login_attempts').values({ at, ip, username, outcome }).execute();
  }

  /**
   * Failures for one address inside the lockout window.
   *
   * Deliberately keyed on IP alone. Counting failures per username would let
   * anyone lock a known account out by failing against it.
   */
  async recentFailuresByIp(ip: string, since: number): Promise<number> {
    const row = await this.#db
      .selectFrom('login_attempts')
      .select((eb) => eb.fn.countAll().as('n'))
      .where('ip', '=', ip)
      .where('at', '>=', since)
      .where('outcome', '!=', 'ok')
      .executeTakeFirstOrThrow();

    return Number(row.n);
  }
}
