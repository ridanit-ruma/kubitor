import { beforeAll, expect, it } from 'vitest';
import { describeEachDialect } from '../test/db-harness.js';
import { AccountEventsRepo } from './account-events.repo.js';
import { AccountsRepo } from './accounts.repo.js';
import { LoginAttemptsRepo } from './login-attempts.repo.js';
import { migrateToLatest } from './migrate.js';
import { SessionsRepo } from './sessions.repo.js';

const NOW = 1_756_800_000_000;
const HOUR_MS = 3_600_000;

describeEachDialect('AccountsRepo', (ctx) => {
  let repo: AccountsRepo;

  beforeAll(async () => {
    await migrateToLatest(ctx.db, ctx.kind);
    repo = new AccountsRepo(ctx.db);
  });

  it('creates and finds an account by username and by id', async () => {
    const created = await repo.create(
      { username: 'admin', passwordHash: 'scrypt$1', mustChangePassword: true },
      NOW,
    );

    expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(created.mustChangePassword).toBe(true);
    expect(await repo.byUsername('admin')).toEqual(created);
    expect(await repo.byId(created.id)).toEqual(created);
  });

  it('returns undefined for an account that does not exist', async () => {
    expect(await repo.byUsername('nobody')).toBeUndefined();
    expect(await repo.byId('00000000-0000-0000-0000-000000000000')).toBeUndefined();
  });

  it('refuses a duplicate username', async () => {
    await repo.create({ username: 'dupe', passwordHash: 'h', mustChangePassword: false }, NOW);

    await expect(
      repo.create({ username: 'dupe', passwordHash: 'h', mustChangePassword: false }, NOW),
    ).rejects.toThrow();
  });

  it('changes a password and clears the must-change flag', async () => {
    const account = await repo.create(
      { username: 'rotate', passwordHash: 'old', mustChangePassword: true },
      NOW,
    );

    await repo.setPassword(account.id, 'new', false);

    const reloaded = await repo.byId(account.id);
    expect(reloaded?.passwordHash).toBe('new');
    expect(reloaded?.mustChangePassword).toBe(false);
  });

  it('counts and lists accounts by username', async () => {
    const names = (await repo.list()).map((a) => a.username);

    expect(names).toEqual([...names].sort());
    expect(await repo.count()).toBe(names.length);
  });

  it('deletes an account', async () => {
    const account = await repo.create(
      { username: 'temp', passwordHash: 'h', mustChangePassword: false },
      NOW,
    );

    await repo.delete(account.id);

    expect(await repo.byId(account.id)).toBeUndefined();
  });
});

describeEachDialect('SessionsRepo', (ctx) => {
  let accounts: AccountsRepo;
  let sessions: SessionsRepo;
  let accountId: string;

  beforeAll(async () => {
    await migrateToLatest(ctx.db, ctx.kind);
    accounts = new AccountsRepo(ctx.db);
    sessions = new SessionsRepo(ctx.db);
    accountId = (
      await accounts.create({ username: 's', passwordHash: 'h', mustChangePassword: false }, NOW)
    ).id;
  });

  it('issues an unguessable id and an expiry', async () => {
    const session = await sessions.create(accountId, HOUR_MS, NOW);

    expect(session.id).toMatch(/^[0-9a-f]{64}$/);
    expect(session.expiresAt).toBe(NOW + HOUR_MS);
    expect(await sessions.byId(session.id)).toEqual(session);
  });

  it('records when a session was last seen', async () => {
    const session = await sessions.create(accountId, HOUR_MS, NOW);

    await sessions.touch(session.id, NOW + 60_000);

    expect((await sessions.byId(session.id))?.lastSeenAt).toBe(NOW + 60_000);
  });

  it('deletes every session for an account except the one held back', async () => {
    const keep = await sessions.create(accountId, HOUR_MS, NOW);
    await sessions.create(accountId, HOUR_MS, NOW);
    await sessions.create(accountId, HOUR_MS, NOW);

    const removed = await sessions.deleteForAccount(accountId, keep.id);

    expect(removed).toBeGreaterThanOrEqual(2);
    expect(await sessions.byId(keep.id)).toBeDefined();
  });

  it('deletes expired sessions and keeps live ones', async () => {
    await sessions.deleteForAccount(accountId);
    const stale = await sessions.create(accountId, HOUR_MS, NOW - 2 * HOUR_MS);
    const live = await sessions.create(accountId, HOUR_MS, NOW);

    const removed = await sessions.deleteExpired(NOW);

    expect(removed).toBe(1);
    expect(await sessions.byId(stale.id)).toBeUndefined();
    expect(await sessions.byId(live.id)).toBeDefined();
  });
});

describeEachDialect('LoginAttemptsRepo', (ctx) => {
  let repo: LoginAttemptsRepo;

  beforeAll(async () => {
    await migrateToLatest(ctx.db, ctx.kind);
    repo = new LoginAttemptsRepo(ctx.db);
  });

  it('counts only failures, only for the given address, only in the window', async () => {
    await repo.record(NOW, '10.0.0.1', 'a', 'bad_password');
    await repo.record(NOW, '10.0.0.1', 'a', 'unknown_user');
    await repo.record(NOW, '10.0.0.1', 'a', 'ok');
    await repo.record(NOW - HOUR_MS, '10.0.0.1', 'a', 'bad_password');
    await repo.record(NOW, '10.0.0.2', 'a', 'bad_password');

    expect(await repo.recentFailuresByIp('10.0.0.1', NOW - 60_000)).toBe(2);
  });
});

describeEachDialect('AccountEventsRepo', (ctx) => {
  let repo: AccountEventsRepo;

  beforeAll(async () => {
    await migrateToLatest(ctx.db, ctx.kind);
    repo = new AccountEventsRepo(ctx.db, ctx.sqlHelper);
  });

  it('round-trips an audit entry newest first', async () => {
    await repo.record({
      at: NOW,
      actorId: null,
      action: 'create',
      subject: 'bob',
      detail: { by: 'bootstrap' },
    });
    await repo.record({
      at: NOW + 1000,
      actorId: 'a1',
      action: 'delete',
      subject: 'bob',
      detail: {},
    });

    const events = await repo.list(10);

    expect(events[0]?.action).toBe('delete');
    expect(events[1]?.detail).toEqual({ by: 'bootstrap' });
    expect(events[1]?.actorId).toBeNull();
  });
});
