import type { AgentTokensRepo } from '../db/agent-tokens.repo.js';
import { verifyPassword } from './password.js';

export type AgentsError = 'reauthentication_failed' | 'invalid_name' | 'not_found';

export type AgentsResult<T> = { ok: true; value: T } | { ok: false; error: AgentsError };

/** What the Agents panel shows about one credential. */
export interface AgentSummary {
  name: string;
  createdAt: number;
  lastSeenAt: number | null;
  /**
   * The name is also a cluster node.
   *
   * Not an error: a kubelet that cannot project a token still needs a static
   * one, so this is a supported deployment. It is also a second and weaker path
   * to that node's identity, which is why it is shown rather than forbidden.
   */
  isNode: boolean;
}

/**
 * Only what a host is allowed to be called.
 *
 * The name reaches URLs, log lines and every facet row the machine writes, and
 * it is what one agent is prevented from claiming to be another. Keep it to
 * what a hostname can be.
 */
const NAME = /^[a-z0-9][a-z0-9.-]{0,252}$/;

/** The actor, as SessionGuard has already loaded them. */
export interface Actor {
  passwordHash: string;
}

export class AgentsService {
  readonly #tokens: AgentTokensRepo;

  constructor(tokens: AgentTokensRepo) {
    this.#tokens = tokens;
  }

  async list(nodeNames: readonly string[]): Promise<AgentSummary[]> {
    const nodes = new Set(nodeNames);

    return (await this.#tokens.list()).map((token) => ({
      name: token.node,
      createdAt: token.createdAt,
      lastSeenAt: token.lastSeenAt,
      isNode: nodes.has(token.node),
    }));
  }

  /**
   * Mints a credential, returning the plaintext once.
   *
   * Re-authentication is required because a session cookie alone should not
   * mint something that can write telemetry for a machine. Only the hash is
   * stored, so there is no second chance to read the token.
   */
  async issue(
    actor: Actor,
    password: string,
    name: string,
    now: number,
  ): Promise<AgentsResult<{ name: string; token: string }>> {
    if (!(await verifyPassword(password, actor.passwordHash))) {
      return { ok: false, error: 'reauthentication_failed' };
    }
    if (!NAME.test(name)) return { ok: false, error: 'invalid_name' };

    return { ok: true, value: { name, token: await this.#tokens.issue(name, now) } };
  }

  async revoke(actor: Actor, password: string, name: string): Promise<AgentsResult<undefined>> {
    if (!(await verifyPassword(password, actor.passwordHash))) {
      return { ok: false, error: 'reauthentication_failed' };
    }

    const known = await this.#tokens.list();
    if (!known.some((token) => token.node === name)) return { ok: false, error: 'not_found' };

    await this.#tokens.revoke(name);
    return { ok: true, value: undefined };
  }
}
