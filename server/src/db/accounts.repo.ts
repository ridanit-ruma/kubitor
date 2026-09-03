import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import type { Database } from './schema.js';

/** Domain shape. The 0/1 integer never escapes this module. */
export interface Account {
  id: string;
  username: string;
  passwordHash: string;
  mustChangePassword: boolean;
  createdAt: number;
  disabledAt: number | null;
}

export interface NewAccount {
  username: string;
  passwordHash: string;
  mustChangePassword: boolean;
}

export class AccountsRepo {
  readonly #db: Kysely<Database>;

  constructor(db: Kysely<Database>) {
    this.#db = db;
  }

  async create(account: NewAccount, now: number): Promise<Account> {
    const row = {
      id: randomUUID(),
      username: account.username,
      password_hash: account.passwordHash,
      must_change_password: account.mustChangePassword ? 1 : 0,
      created_at: now,
      disabled_at: null,
    };

    await this.#db.insertInto('accounts').values(row).execute();
    return toAccount(row);
  }

  async byUsername(username: string): Promise<Account | undefined> {
    const row = await this.#db
      .selectFrom('accounts')
      .selectAll()
      .where('username', '=', username)
      .executeTakeFirst();

    return row && toAccount(row);
  }

  async byId(id: string): Promise<Account | undefined> {
    const row = await this.#db
      .selectFrom('accounts')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();

    return row && toAccount(row);
  }

  async list(): Promise<Account[]> {
    const rows = await this.#db
      .selectFrom('accounts')
      .selectAll()
      .orderBy('username', 'asc')
      .execute();

    return rows.map(toAccount);
  }

  async count(): Promise<number> {
    const row = await this.#db
      .selectFrom('accounts')
      .select((eb) => eb.fn.countAll().as('n'))
      .executeTakeFirstOrThrow();

    return Number(row.n);
  }

  async setPassword(id: string, passwordHash: string, mustChange: boolean): Promise<void> {
    await this.#db
      .updateTable('accounts')
      .set({ password_hash: passwordHash, must_change_password: mustChange ? 1 : 0 })
      .where('id', '=', id)
      .execute();
  }

  async delete(id: string): Promise<void> {
    await this.#db.deleteFrom('accounts').where('id', '=', id).execute();
  }
}

interface AccountRow {
  id: string;
  username: string;
  password_hash: string;
  must_change_password: number;
  created_at: number;
  disabled_at: number | null;
}

function toAccount(row: AccountRow): Account {
  return {
    id: row.id,
    username: row.username,
    passwordHash: row.password_hash,
    mustChangePassword: row.must_change_password === 1,
    // PostgreSQL returns bigint columns as strings.
    createdAt: Number(row.created_at),
    disabledAt: row.disabled_at === null ? null : Number(row.disabled_at),
  };
}
