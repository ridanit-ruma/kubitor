import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../test/app-harness.js';

let harness: TestApp;
let token: string;

function http() {
  return request(harness.app.getHttpServer());
}

function reading(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { at: Date.now(), cpu_mhz: 2400, temps: { 'coretemp.Package id 0': 41.5 }, ...overrides };
}

async function stored(): Promise<{ node: string; cpu_mhz: number | null }[]> {
  return harness.db.selectFrom('facet_host_hardware').select(['node', 'cpu_mhz']).execute();
}

beforeEach(async () => {
  harness = await createTestApp();
  token = await harness.agentTokens.issue('ken', Date.now());
});

afterEach(async () => {
  await harness.close();
});

describe('POST /api/ingest/hardware', () => {
  it('stores a batch from a node that holds a token', async () => {
    const response = await http()
      .post('/api/ingest/hardware')
      .set('Authorization', `Bearer ${token}`)
      .send({ rows: [reading(), reading()] });

    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({ accepted: 2, dropped: 0 });
    expect(await stored()).toHaveLength(2);
  });

  it('records when the node was last heard from', async () => {
    await http()
      .post('/api/ingest/hardware')
      .set('Authorization', `Bearer ${token}`)
      .send({ rows: [reading()] });

    const tokens = await harness.agentTokens.list();
    expect(tokens[0]?.lastSeenAt).toBeGreaterThan(0);
  });

  /**
   * The reason tokens are per node rather than shared: a compromised agent must
   * not be able to fabricate readings for the rest of the fleet.
   */
  it('rewrites a row that claims to come from another node', async () => {
    await http()
      .post('/api/ingest/hardware')
      .set('Authorization', `Bearer ${token}`)
      .send({ rows: [reading({ node: 'usher' })] });

    expect((await stored())[0]?.node).toBe('ken');
  });

  it('refuses a request with no token', async () => {
    const response = await http()
      .post('/api/ingest/hardware')
      .send({ rows: [reading()] });

    expect(response.status).toBe(401);
    expect(await stored()).toHaveLength(0);
  });

  it('refuses an unknown token', async () => {
    const response = await http()
      .post('/api/ingest/hardware')
      .set('Authorization', 'Bearer not-a-real-token')
      .send({ rows: [reading()] });

    expect(response.status).toBe(401);
  });

  it('refuses a revoked token', async () => {
    await harness.agentTokens.revoke('ken');

    const response = await http()
      .post('/api/ingest/hardware')
      .set('Authorization', `Bearer ${token}`)
      .send({ rows: [reading()] });

    expect(response.status).toBe(401);
  });

  /**
   * The wedge rule. A deployed sender only advances its buffer on success, so a
   * batch refused for one bad row would stop that node reporting forever.
   */
  it('drops a malformed row and still accepts the batch', async () => {
    const response = await http()
      .post('/api/ingest/hardware')
      .set('Authorization', `Bearer ${token}`)
      .send({ rows: [reading(), { at: 'not-a-number' }, reading()] });

    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({ accepted: 2, dropped: 1 });
    expect(await stored()).toHaveLength(2);
  });

  it('refuses a facet an agent may not write', async () => {
    const response = await http()
      .post('/api/ingest/http.access')
      .set('Authorization', `Bearer ${token}`)
      .send({ rows: [] });

    expect(response.status).toBe(400);
  });

  it('refuses a batch larger than the cap', async () => {
    const response = await http()
      .post('/api/ingest/hardware')
      .set('Authorization', `Bearer ${token}`)
      .send({ rows: Array.from({ length: 1001 }, () => reading()) });

    expect(response.status).toBe(400);
  });

  it('needs no session cookie, since agents have no session', async () => {
    const response = await http()
      .post('/api/ingest/hardware')
      .set('Authorization', `Bearer ${token}`)
      .send({ rows: [reading()] });

    expect(response.status).toBe(202);
  });
});

describe('AgentTokensRepo', () => {
  it('issues a distinct token per node and resolves it back', async () => {
    const other = await harness.agentTokens.issue('usher', Date.now());

    expect(other).not.toBe(token);
    expect(await harness.agentTokens.nodeFor(token)).toBe('ken');
    expect(await harness.agentTokens.nodeFor(other)).toBe('usher');
  });

  it('replaces a node token when it is reissued', async () => {
    const replacement = await harness.agentTokens.issue('ken', Date.now());

    expect(await harness.agentTokens.nodeFor(token)).toBeNull();
    expect(await harness.agentTokens.nodeFor(replacement)).toBe('ken');
  });

  /** A leaked database must not hand over usable tokens. */
  it('never stores the token itself', async () => {
    const rows = await harness.db.selectFrom('agent_tokens').select('token_hash').execute();

    expect(rows[0]?.token_hash).not.toContain(token);
    expect(rows[0]?.token_hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('POST /api/ingest/host', () => {
  function host(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      at: Date.now(),
      node: 'a-node-the-caller-is-not',
      cpu_mhz_avg: 2300,
      cpu_mhz_max: 4400,
      mem_total_bytes: 24_955_392_000,
      mem_available_bytes: 22_000_000_000,
      mem_used_bytes: 2_955_392_000,
      gpus: [],
      disks: [],
      temps: {},
      ...overrides,
    };
  }

  it('accepts a reading and makes it live immediately', async () => {
    await http()
      .post('/api/ingest/host')
      .set('authorization', `Bearer ${token}`)
      .send({ rows: [host()] })
      .expect(202);

    expect(harness.liveCache.reportingHosts(Date.now())).toEqual(['ken']);
  });

  /**
   * The credential names the node. A row claiming another one is rewritten, so
   * a single compromised agent cannot fabricate a healthy-looking fleet.
   */
  it('ignores the node a row claims to be', async () => {
    await http()
      .post('/api/ingest/host')
      .set('authorization', `Bearer ${token}`)
      .send({ rows: [host({ node: 'calder' })] })
      .expect(202);

    expect(harness.liveCache.reportingHosts(Date.now())).toEqual(['ken']);
  });

  it('refuses a request with no credential', async () => {
    await http()
      .post('/api/ingest/host')
      .send({ rows: [host()] })
      .expect(401);
  });

  it('refuses an unknown credential', async () => {
    await http()
      .post('/api/ingest/host')
      .set('authorization', 'Bearer not-a-real-token')
      .send({ rows: [host()] })
      .expect(401);
  });

  it('keeps the batch when one reading is malformed', async () => {
    const response = await http()
      .post('/api/ingest/host')
      .set('authorization', `Bearer ${token}`)
      .send({ rows: [{ at: 'nonsense' }, host()] })
      .expect(202);

    expect(response.body.accepted).toBe(1);
    expect(response.body.dropped).toBe(1);
  });

  it('records when the node was last heard from', async () => {
    await http()
      .post('/api/ingest/host')
      .set('authorization', `Bearer ${token}`)
      .send({ rows: [host()] })
      .expect(202);

    const [entry] = await harness.agentTokens.list();
    expect(entry?.lastSeenAt).not.toBeNull();
  });
});
