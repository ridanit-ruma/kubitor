import { beforeEach, expect, it } from 'vitest';
import { AgentTokensRepo } from '../db/agent-tokens.repo.js';
import { migrateToLatest } from '../db/migrate.js';
import { describeEachDialect } from '../test/db-harness.js';
import { AgentsService } from './agents.service.js';
import { hashPassword } from './password.js';

const NOW = 1_756_800_000_000;

describeEachDialect('AgentsService', (ctx) => {
  let service: AgentsService;
  let actor: { passwordHash: string };

  beforeEach(async () => {
    await migrateToLatest(ctx.db, ctx.kind);
    await ctx.db.deleteFrom('agent_tokens').execute();

    service = new AgentsService(new AgentTokensRepo(ctx.db));
    actor = { passwordHash: await hashPassword('correct horse') };
  });

  it('issues a token that is returned exactly once', async () => {
    const issued = await service.issue(actor, 'correct horse', 'buildbox', NOW);

    expect(issued.ok).toBe(true);
    if (!issued.ok) return;
    expect(issued.value.token).toMatch(/^[A-Za-z0-9_-]{20,}$/);

    const listed = await service.list([]);
    expect(listed).toEqual([{ name: 'buildbox', createdAt: NOW, lastSeenAt: null, isNode: false }]);
    // Only the hash is stored, so nothing can hand the plaintext back.
    expect(JSON.stringify(listed)).not.toContain(issued.value.token);
  });

  /**
   * A warm session cookie is not enough to mint a credential that can write
   * telemetry for a machine.
   */
  it("refuses to issue without the actor's own password", async () => {
    expect(await service.issue(actor, 'wrong', 'buildbox', NOW)).toEqual({
      ok: false,
      error: 'reauthentication_failed',
    });
    expect(await service.list([])).toEqual([]);
  });

  /**
   * A static token for a name that is also a node is a supported deployment —
   * a kubelet that cannot project tokens — and also a second, weaker path to
   * that node's identity. It is marked, not forbidden.
   */
  it('marks a name that is also a cluster node', async () => {
    await service.issue(actor, 'correct horse', 'ken', NOW);

    expect((await service.list(['ken', 'calder']))[0]?.isNode).toBe(true);
  });

  it('refuses a name that is not a plausible host name', async () => {
    expect(await service.issue(actor, 'correct horse', 'Build Box!', NOW)).toEqual({
      ok: false,
      error: 'invalid_name',
    });
  });

  it('revokes a token so the name is no longer known', async () => {
    await service.issue(actor, 'correct horse', 'buildbox', NOW);

    expect(await service.revoke(actor, 'correct horse', 'buildbox')).toEqual({
      ok: true,
      value: undefined,
    });
    expect(await service.list([])).toEqual([]);
  });

  it("refuses to revoke without the actor's own password", async () => {
    await service.issue(actor, 'correct horse', 'buildbox', NOW);

    expect(await service.revoke(actor, 'wrong', 'buildbox')).toEqual({
      ok: false,
      error: 'reauthentication_failed',
    });
    expect(await service.list([])).toHaveLength(1);
  });

  it('reports a name it does not know rather than reporting success', async () => {
    expect(await service.revoke(actor, 'correct horse', 'nowhere')).toEqual({
      ok: false,
      error: 'not_found',
    });
  });

  /** Re-issuing replaces the token rather than leaving two ways in. */
  it('replaces the token when a name is issued twice', async () => {
    const first = await service.issue(actor, 'correct horse', 'buildbox', NOW);
    const second = await service.issue(actor, 'correct horse', 'buildbox', NOW + 1000);

    expect(first.ok && second.ok && first.value.token === second.value.token).toBe(false);
    expect(await service.list([])).toHaveLength(1);
  });
});
