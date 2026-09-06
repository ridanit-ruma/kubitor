/**
 * A ping outwards, so that silence can be somebody else's alarm.
 *
 * The last layer, and the smallest. The agents (see the agent's witness.ts)
 * cover the server or its node dying, because they are alive to notice. What
 * neither they nor kubitor can cover is the site or its uplink disappearing:
 * when everything is gone, nothing inside is left to say so.
 *
 * So kubitor pings a URL while it is alive, and something outside — healthchecks.io,
 * Uptime Kuma, cron-job.org — raises the alarm when the pings stop. It is one
 * request on a timer, deliberately: an outage this covers is total, and there
 * is nothing cleverer to do about it from in here.
 */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 60_000;

export interface HeartbeatDeps {
  /** Absent means off, which is the default. */
  url: string | null;
  intervalMs?: number;
  fetch?: typeof globalThis.fetch;
  log?(message: string): void;
}

export class Heartbeat {
  readonly #deps: HeartbeatDeps;
  readonly #intervalMs: number;
  #timer: ReturnType<typeof setInterval> | null = null;
  #complainedAt = 0;

  constructor(deps: HeartbeatDeps) {
    this.#deps = deps;
    this.#intervalMs = deps.intervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  }

  get enabled(): boolean {
    return this.#deps.url !== null;
  }

  start(): void {
    if (this.#timer || !this.enabled) return;
    void this.beat();
    this.#timer = setInterval(() => void this.beat(), this.#intervalMs);
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  /**
   * One ping. Never throws.
   *
   * A failure here means the outside world is unreachable, which is exactly
   * the condition the receiver is about to notice on its own. Complaining
   * about it once a while is worth a log line; doing anything more energetic
   * would be kubitor treating its own uplink as an emergency it can fix.
   */
  async beat(): Promise<boolean> {
    const url = this.#deps.url;
    if (url === null) return false;

    try {
      const send = this.#deps.fetch ?? globalThis.fetch;
      const response = await send(url, { method: 'GET' });
      if (response.ok) return true;

      this.#complain(`heartbeat to ${url} answered ${response.status}`);
      return false;
    } catch (error) {
      this.#complain(`heartbeat to ${url} failed: ${String(error)}`);
      return false;
    }
  }

  #complain(message: string): void {
    const now = Date.now();
    if (now - this.#complainedAt < 3_600_000) return;
    this.#complainedAt = now;
    this.#deps.log?.(message);
  }
}
