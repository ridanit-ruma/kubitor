import { readFile } from 'node:fs/promises';
import { readSessions, type SessionsProblem } from './sessions.js';
import { type AccessAttempt, parseSshdLine } from './sshd-log.js';

/**
 * How much of this the agent is allowed to collect.
 *
 * `off` is the default and means exactly that: nothing is read and nothing is
 * sent. This is a feature people are subject to, and the switch belongs on the
 * machine being watched rather than on the dashboard watching it.
 */
export type SessionMode = 'off' | 'access' | 'full';

export function sessionModeFrom(value: string | undefined): SessionMode {
  return value === 'access' || value === 'full' ? value : 'off';
}

export interface AccessRow extends Record<string, unknown> {
  at: number;
  node: string;
  outcome: AccessAttempt['outcome'];
  method: AccessAttempt['method'];
  user: string;
  client_ip: string;
  client_port: number | null;
  sshd_pid: number | null;
}

export interface SessionRow extends Record<string, unknown> {
  observed_at: number;
  node: string;
  user: string;
  tty: string | null;
  kind: 'shell' | 'exec' | 'sftp' | 'forward';
  pid: number;
  since: number;
  from_ip: string | null;
}

export interface CollectorOptions {
  node: string;
  mode: SessionMode;
  /**
   * A plain-text auth log, where one exists.
   *
   * `/var/log/auth.log` on Debian, `/var/log/secure` on RHEL. Not journald: the
   * agent's image has no `journalctl` and cannot get one, so a host that logs
   * only to the journal has no attempts to read from inside a pod. That is
   * stated on the screen rather than shown as "nobody has tried to log in".
   */
  authLogPath: string | null;
  procRoot?: string;
  now?(): number;
}

export interface SessionCollection {
  access: AccessRow[];
  sessions: SessionRow[];
  /** Why the sessions list may be empty for reasons other than nobody being on. */
  sessionsProblem: SessionsProblem | null;
  /** Whether attempts could be read at all. */
  accessAvailable: boolean;
}

/**
 * Reads who tried to get in and who is in, once.
 *
 * The two halves fail independently and are reported independently, because
 * they usually *do* fail independently: inside a pod the sessions are readable
 * and the log is not, and on a host with the agent as a systemd unit both are.
 */
export class SessionCollector {
  readonly #options: CollectorOptions;
  readonly #now: () => number;
  /** How far into the log this agent has already read. */
  #logOffset: number | null = null;

  constructor(options: CollectorOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => Date.now());
  }

  get enabled(): boolean {
    return this.#options.mode !== 'off';
  }

  async collect(): Promise<SessionCollection> {
    if (!this.enabled) {
      return { access: [], sessions: [], sessionsProblem: null, accessAvailable: false };
    }

    const [access, sessions] = await Promise.all([this.#readAccess(), this.#readSessions()]);

    return {
      access: access.rows,
      accessAvailable: access.available,
      sessions: sessions.rows,
      sessionsProblem: sessions.problem,
    };
  }

  async #readSessions(): Promise<{ rows: SessionRow[]; problem: SessionsProblem | null }> {
    const reading = await readSessions(this.#options.procRoot ?? '/proc');
    const observedAt = this.#now();

    return {
      rows: reading.sessions.map((session) => ({
        observed_at: observedAt,
        node: this.#options.node,
        user: session.user,
        tty: session.tty,
        kind: session.kind,
        pid: session.pid,
        since: session.since,
        // The client's address lives in sshd's log or in the session's own
        // environment, and the agent can read neither as `nobody`. Saying null
        // is honest; inventing one would not be.
        from_ip: null,
      })),
      problem: reading.problem,
    };
  }

  /**
   * New lines since the last read.
   *
   * Byte offsets rather than timestamps, and a reset when the file shrinks:
   * logrotate replaces the file underneath a long-running agent, and an offset
   * kept across that would skip everything until the new file grew past it.
   *
   * The first read establishes the offset and reports nothing. Importing a
   * whole log on every restart would backdate thousands of attempts that were
   * already recorded.
   */
  async #readAccess(): Promise<{ rows: AccessRow[]; available: boolean }> {
    const path = this.#options.authLogPath;
    if (path === null) return { rows: [], available: false };

    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch {
      return { rows: [], available: false };
    }

    const size = Buffer.byteLength(text);
    if (this.#logOffset === null || size < this.#logOffset) {
      this.#logOffset = size;
      return { rows: [], available: true };
    }

    const fresh = text.slice(this.#logOffset);
    this.#logOffset = size;

    const at = this.#now();
    const rows: AccessRow[] = [];
    for (const line of fresh.split('\n')) {
      const attempt = parseSshdLine(line);
      if (!attempt) continue;

      rows.push({
        at,
        node: this.#options.node,
        outcome: attempt.outcome,
        method: attempt.method,
        user: attempt.user,
        client_ip: attempt.clientIp,
        client_port: attempt.clientPort,
        sshd_pid: attempt.sshdPid,
      });
    }

    return { rows, available: true };
  }
}
