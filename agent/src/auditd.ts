/**
 * Complete command records, where auditd is installed to produce them.
 *
 * The sampler in commands.ts misses anything shorter than its interval, which
 * is most commands. auditd sees every `execve` and misses nothing — at the cost
 * of being a separate thing to install, configure and keep running. So this is
 * a capability that may or may not be there, exactly like an ingress
 * controller: where it is, the same screen gets better rows and says so.
 *
 * The rule an operator has to add for these to exist at all:
 *
 *   -a always,exit -F arch=b64 -S execve -F auid>=1000 -F auid!=unset -k kubitor
 *
 * Two record types carry one execution between them. SYSCALL has who and
 * where; EXECVE has what. They are joined by the event id inside `msg=audit(…)`,
 * which is why neither can be read alone.
 */
export interface AuditCommand {
  /** Epoch milliseconds, from the event id itself. */
  at: number;
  /** The login session, which ties this to an sshd session. */
  auditSession: number | null;
  /** The account that logged in, not the one the process ended up running as. */
  loginUid: number | null;
  pid: number;
  comm: string;
  argv: string[];
}

interface Partial_ {
  at: number;
  auditSession: number | null;
  loginUid: number | null;
  pid: number;
  comm: string;
}

/** `msg=audit(1788685480.123:456)` — seconds, milliseconds, and a serial. */
const EVENT = /msg=audit\((\d+)\.(\d+):(\d+)\)/;

function field(line: string, name: string): string | null {
  const match = new RegExp(`\\b${name}=("[^"]*"|\\S+)`).exec(line);
  if (!match) return null;
  const raw = match[1] as string;
  return raw.startsWith('"') ? raw.slice(1, -1) : raw;
}

function numeric(line: string, name: string): number | null {
  const value = field(line, name);
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * An argument, which auditd hex-encodes whenever it contains anything awkward.
 *
 * An unquoted value is hex; a quoted one is literal. Getting this backwards
 * turns every command with a space in it into a wall of digits.
 */
function decodeArg(raw: string): string {
  if (raw.startsWith('"')) return raw.slice(1, -1);
  if (!/^[0-9A-Fa-f]+$/.test(raw) || raw.length % 2 !== 0) return raw;

  let out = '';
  for (let index = 0; index < raw.length; index += 2) {
    out += String.fromCharCode(Number.parseInt(raw.slice(index, index + 2), 16));
  }
  return out;
}

/**
 * Parses a run of audit lines into completed executions.
 *
 * Stateful across calls is deliberately *not* how this works: a SYSCALL and its
 * EXECVE are adjacent in the file, so a chunk that splits them loses one
 * execution rather than corrupting the next chunk's.
 */
export function parseAuditLines(lines: readonly string[]): AuditCommand[] {
  const pending = new Map<string, Partial_>();
  const commands: AuditCommand[] = [];

  for (const line of lines) {
    const event = EVENT.exec(line);
    if (!event) continue;

    const id = `${event[1]}.${event[2]}:${event[3]}`;

    if (line.startsWith('type=SYSCALL')) {
      // Only executions. The rule above asks for execve alone, but an operator
      // with other rules in place will have other syscalls in the same file.
      if (field(line, 'syscall') !== '59' && field(line, 'syscall') !== 'execve') continue;

      const auid = numeric(line, 'auid');
      pending.set(id, {
        at: Number(event[1]) * 1000 + Number(event[2]),
        // 4294967295 is auid unset: a process with no login behind it, which is
        // a daemon rather than a person.
        auditSession: unsetToNull(numeric(line, 'ses')),
        loginUid: unsetToNull(auid),
        pid: numeric(line, 'pid') ?? 0,
        comm: field(line, 'comm') ?? '',
      });
      continue;
    }

    if (line.startsWith('type=EXECVE')) {
      const started = pending.get(id);
      if (!started) continue;
      pending.delete(id);

      const argv: string[] = [];
      for (let index = 0; ; index += 1) {
        const raw = new RegExp(`\\ba${index}=("[^"]*"|\\S+)`).exec(line);
        if (!raw) break;
        argv.push(decodeArg(raw[1] as string));
      }

      commands.push({ ...started, argv });
    }
  }

  return commands;
}

/** auditd writes 4294967295 for "no login session", which is not a session. */
function unsetToNull(value: number | null): number | null {
  return value === null || value === 4_294_967_295 ? null : value;
}
