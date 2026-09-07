import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseAuditLines } from './auditd.js';
import { CommandDiff, readSessionCommands } from './commands.js';
import { redactArgv } from './redact.js';
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

export interface CommandRow extends Record<string, unknown> {
  at: number;
  node: string;
  session_pid: number | null;
  user: string;
  pid: number;
  comm: string;
  argv: string;
  source: 'sampled' | 'audit';
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
  /** The kernel's login session, which is how an audited command finds this row. */
  audit_session: number | null;
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
  /** Record the program only, never its arguments. */
  commOnly?: boolean;
  /**
   * auditd's log, where it is installed and readable.
   *
   * Complete where the sampler is not: every `execve`, none missed. It is a
   * separate thing to install and configure, so its absence is the normal case
   * and never an error.
   */
  auditLogPath?: string | null;
  now?(): number;
}

export interface SessionCollection {
  access: AccessRow[];
  sessions: SessionRow[];
  /** Empty unless the mode is `full`. Every row says whether it was sampled. */
  commands: CommandRow[];
  /** Whether auditd supplied them, which is the difference between complete and not. */
  commandsComplete: boolean;
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
  readonly #commands = new CommandDiff();
  /** How far into the log this agent has already read. */
  #logOffset: number | null = null;
  #auditOffset: number | null = null;

  constructor(options: CollectorOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => Date.now());
  }

  get enabled(): boolean {
    return this.#options.mode !== 'off';
  }

  async collect(): Promise<SessionCollection> {
    if (!this.enabled) {
      return {
        access: [],
        sessions: [],
        commands: [],
        commandsComplete: false,
        sessionsProblem: null,
        accessAvailable: false,
      };
    }

    const [access, sessions] = await Promise.all([this.#readAccess(), this.#readSessions()]);

    const commands = await this.#readCommands(sessions.rows);

    return {
      access: access.rows,
      accessAvailable: access.available,
      sessions: sessions.rows,
      sessionsProblem: sessions.problem,
      commands: commands.rows,
      commandsComplete: commands.complete,
    };
  }

  /**
   * Every execution auditd recorded since the last read, for these sessions.
   *
   * Matched by the kernel's login session id rather than by pid, because that
   * is what auditd records — an audited command knows which login it belongs to
   * and not which sshd process served it.
   */
  async #readAudit(
    sessions: readonly SessionRow[],
  ): Promise<{ rows: CommandRow[]; available: boolean }> {
    const path = this.#options.auditLogPath ?? null;
    if (path === null) return { rows: [], available: false };

    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch {
      // Present in configuration and unreadable in practice — auditd's log is
      // root-only, so an agent running as `nobody` lands here. Not an error;
      // the sampler covers it and the screen says which it is looking at.
      return { rows: [], available: false };
    }

    const size = Buffer.byteLength(text);
    if (this.#auditOffset === null || size < this.#auditOffset) {
      this.#auditOffset = size;
      return { rows: [], available: true };
    }

    const fresh = text.slice(this.#auditOffset);
    this.#auditOffset = size;

    const bySession = new Map<number, SessionRow>();
    for (const session of sessions) {
      const id = session.audit_session;
      if (typeof id === 'number') bySession.set(id, session);
    }

    const rows: CommandRow[] = [];
    for (const command of parseAuditLines(fresh.split('\n'))) {
      if (command.auditSession === null) continue;
      const session = bySession.get(command.auditSession);
      if (!session) continue;

      rows.push({
        at: command.at,
        node: this.#options.node,
        session_pid: session.pid,
        user: session.user,
        pid: command.pid,
        comm: command.comm,
        argv: this.#options.commOnly ? '' : redactArgv(command.argv).join(' '),
        source: 'audit',
      });
    }

    return { rows, available: true };
  }

  /**
   * What is running inside the sessions just read, once each.
   *
   * `full` only. `access` reports who is connected and stops there, because
   * "who is on the machine" and "what they are typing" are different things to
   * agree to, and the second should not arrive as a side effect of the first.
   */
  async #readCommands(
    sessions: readonly SessionRow[],
  ): Promise<{ rows: CommandRow[]; complete: boolean }> {
    if (this.#options.mode !== 'full' || sessions.length === 0) {
      return { rows: [], complete: false };
    }

    // auditd where it exists, and the sampler only where it does not. Running
    // both would report the same execution twice, once complete and once as a
    // guess, which is worse than either alone.
    const audited = await this.#readAudit(sessions);
    if (audited.available) return { rows: audited.rows, complete: true };

    const root = this.#options.procRoot ?? '/proc';
    const bootMs = await bootTimeMs(root);

    const running = await readSessionCommands(
      {
        sessionPids: sessions.map((session) => session.pid),
        procRoot: root,
        ...(this.#options.commOnly === undefined ? {} : { commOnly: this.#options.commOnly }),
      },
      bootMs,
    );

    const owner = new Map(sessions.map((session) => [session.pid, session.user]));
    const at = this.#now();

    return {
      complete: false,
      rows: this.#commands.next(running).map((command) => ({
        at,
        node: this.#options.node,
        session_pid: command.sessionPid,
        user: owner.get(command.sessionPid) ?? '',
        pid: command.pid,
        comm: command.comm,
        argv: command.argv.join(' '),
        source: 'sampled' as const,
      })),
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
        audit_session: session.auditSession,
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

/** Epoch milliseconds of the kernel's boot, which /proc counts everything from. */
async function bootTimeMs(root: string): Promise<number | null> {
  try {
    const stat = await readFile(join(root, 'stat'), 'utf8');
    const btime = /^btime (\d+)$/m.exec(stat);
    return btime ? Number(btime[1]) * 1000 : null;
  } catch {
    return null;
  }
}
