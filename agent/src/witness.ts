/**
 * The alert kubitor cannot send about itself.
 *
 * Nothing inside a process can report that process being gone, and for a long
 * time the answer here was "so you need something outside the cluster". That
 * was too strong. An agent runs on every node, talks to the server every
 * second, and is therefore the only thing that knows when the server has
 * stopped answering — a set of witnesses that is already deployed.
 *
 * What remains genuinely outside reach is the site or its uplink disappearing,
 * which is one ping to a dead-man's switch rather than a subsystem.
 *
 * Two things are true of this and unusual:
 *
 * - **Duplicates are the point.** Coordination needs shared state, the shared
 *   state is the server's database, and the server is what just became
 *   unreachable. Four nodes will send four messages, each naming the node that
 *   observed it — and that is information, not noise: one node reporting means
 *   that node's network, and every node reporting means the server.
 * - **The credential is narrow.** An agent holding the operator's Discord
 *   webhook would put it on every node. This posts one shape of message to one
 *   address and can say nothing else.
 */
export interface WitnessOptions {
  /** Where to shout. Absent means this agent stays quiet, which is the default. */
  url: string | null;
  /** This machine's name, so a reader can tell one observer from four. */
  host: string;
  /**
   * How long the server must be unreachable before saying so.
   *
   * Long on purpose. A restart, a rollout and a brief network blip all look
   * like this for a few seconds, and a witness that fired on those would be
   * the noisiest thing in the estate.
   */
  afterMs: number;
  /** How long between repeats while it is still unreachable. */
  repeatMs: number;
  fetchImpl?: typeof fetch;
  now?(): number;
  log?(message: string): void;
}

export const DEFAULT_AFTER_MS = 300_000;
export const DEFAULT_REPEAT_MS = 3_600_000;

export interface WitnessReport {
  kind: 'server-unreachable';
  host: string;
  /** When this agent last got an answer, or null if it never has. */
  lastContactAt: number | null;
  unreachableForMs: number;
  observedAt: number;
}

/**
 * Watches one agent's own contact with the server and shouts if it stops.
 *
 * Fed by the send loop rather than polling anything: the sender already knows
 * whether the last request landed, and a second opinion would only be able to
 * disagree with it.
 */
export class Witness {
  readonly #options: Required<Pick<WitnessOptions, 'afterMs' | 'repeatMs' | 'host'>> &
    WitnessOptions;
  readonly #now: () => number;
  #lastContactAt: number | null = null;
  #lastShoutedAt: number | null = null;
  #started: number;

  constructor(options: WitnessOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => Date.now());
    this.#started = this.#now();
  }

  get enabled(): boolean {
    return this.#options.url !== null;
  }

  /** Called after every send attempt, whether or not it landed. */
  record(reached: boolean): void {
    if (reached) {
      this.#lastContactAt = this.#now();
      this.#lastShoutedAt = null;
    }
  }

  /**
   * Sends a report if one is due, and returns whether it did.
   *
   * Silent about its own failure beyond a log line: an agent that cannot reach
   * the server and cannot reach the witness address has nothing left to try,
   * and retrying hard would only add load to whatever is already broken.
   */
  async check(): Promise<boolean> {
    const url = this.#options.url;
    if (url === null) return false;

    const now = this.#now();
    const since = this.#lastContactAt ?? this.#started;
    const unreachableForMs = now - since;

    if (unreachableForMs < this.#options.afterMs) return false;
    if (this.#lastShoutedAt !== null && now - this.#lastShoutedAt < this.#options.repeatMs) {
      return false;
    }

    const report: WitnessReport = {
      kind: 'server-unreachable',
      host: this.#options.host,
      lastContactAt: this.#lastContactAt,
      unreachableForMs,
      observedAt: now,
    };

    this.#lastShoutedAt = now;

    try {
      const send = this.#options.fetchImpl ?? globalThis.fetch;
      const response = await send(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(report),
      });

      if (!response.ok) {
        this.#options.log?.(`witness address answered ${response.status}`);
        return false;
      }

      this.#options.log?.(
        `told ${url} that the server has been unreachable for ${Math.round(unreachableForMs / 1000)}s`,
      );
      return true;
    } catch (error) {
      this.#options.log?.(`could not reach the witness address either: ${String(error)}`);
      return false;
    }
  }
}
