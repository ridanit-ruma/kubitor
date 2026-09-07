import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Who is logged in, read from /proc.
 *
 * This is the half of session monitoring that works inside a pod. sshd names
 * the session in its own process title — `sshd: ruma@pts/0` — and that title,
 * the login uid and the process start time are all world-readable, so the
 * agent can read them as `nobody` with every capability dropped. It needs to
 * see the host's processes, which is `hostPID: true` and nothing else.
 *
 * What it cannot get here is the client's address: that lives in sshd's log,
 * or in the session's own environment, which only its owner and root may read.
 * The screen says "from" only when the log reader is also running, rather than
 * inventing one.
 */
export interface HostSession {
  /** The account, as sshd wrote it in its process title. */
  user: string;
  /** `pts/0`, or null for a session with no terminal. */
  tty: string | null;
  /** `shell`, `exec` (`ssh host cmd`), `sftp`, or `forward` with no command. */
  kind: 'shell' | 'exec' | 'sftp' | 'forward';
  /** The session process, which is also its identity for as long as it lives. */
  pid: number;
  /** Epoch milliseconds, derived from the kernel's boot time. */
  since: number;
}

/** Why sessions could not be read, when they could not. */
export type SessionsProblem = 'no-host-pids' | 'hidepid' | 'unreadable';

export interface SessionsReading {
  sessions: HostSession[];
  /**
   * Null when the list is trustworthy.
   *
   * An empty list and "I am not allowed to look" are different answers, and
   * showing the second as the first is how a screen quietly lies. `hidepid` on
   * /proc and a pod without `hostPID` both produce an empty list for reasons
   * that have nothing to do with who is logged in.
   */
  problem: SessionsProblem | null;
}

/** `sshd: ruma@pts/0`, `sshd: ruma [priv]`, `sshd: /usr/sbin/sshd [listener] …` */
const TITLE = /^sshd(?:-session)?:\s+(\S+?)(?:@(\S+))?(?:\s+\[(\w+)\])?\s*$/;

export async function readSessions(root = '/proc'): Promise<SessionsReading> {
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return { sessions: [], problem: 'unreadable' };
  }

  const bootMs = await bootTimeMs(root);
  const pids = entries.filter((name) => /^\d+$/.test(name));

  const sessions: HostSession[] = [];
  let sawAnySshd = false;
  let readAnyCmdline = false;

  for (const pid of pids) {
    const cmdline = await read(join(root, pid, 'cmdline'));
    if (cmdline === null) continue;
    readAnyCmdline = true;

    const title = cmdline.replaceAll('\0', ' ').trim();
    if (!title.startsWith('sshd')) continue;
    sawAnySshd = true;

    const match = TITLE.exec(title);
    if (!match) continue;

    const user = match[1] as string;
    const tty = match[2] ?? null;
    const bracket = match[3] ?? null;

    // The listener is not a session, and the privileged monitor is the same
    // login counted twice — the unprivileged half carries the terminal.
    if (bracket === 'listener' || bracket === 'priv' || user.includes('/')) continue;

    const since = await startedAt(join(root, pid, 'stat'), bootMs);
    if (since === null) continue;

    sessions.push({
      user,
      tty: tty === 'notty' ? null : tty,
      kind: kindOf(tty),
      pid: Number(pid),
      since,
    });
  }

  return {
    sessions: sessions.sort((a, b) => a.since - b.since || a.pid - b.pid),
    problem: problemFor({ readAnyCmdline, sawAnySshd, pids: pids.length }),
  };
}

/**
 * What a session is for, as far as its terminal reveals.
 *
 * `ssh host cmd`, an sftp transfer and a bare port forward all arrive without
 * a terminal, and a list that showed only login shells would miss every one of
 * them — which is most of what automation does over ssh.
 */
function kindOf(tty: string | null | undefined): HostSession['kind'] {
  if (tty && tty !== 'notty') return 'shell';
  return 'exec';
}

function problemFor(seen: {
  readAnyCmdline: boolean;
  sawAnySshd: boolean;
  pids: number;
}): SessionsProblem | null {
  // A /proc with almost nothing in it is a pod looking at its own namespace.
  if (seen.pids <= 2) return 'no-host-pids';
  // Processes are listed but none of their titles can be read: hidepid=2.
  if (!seen.readAnyCmdline) return 'hidepid';
  return null;
}

async function read(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

/** Epoch milliseconds of the kernel's boot, which /proc counts everything from. */
async function bootTimeMs(root: string): Promise<number | null> {
  const stat = await read(join(root, 'stat'));
  const btime = stat === null ? null : /^btime (\d+)$/m.exec(stat);
  return btime ? Number(btime[1]) * 1000 : null;
}

/**
 * When a process started, in epoch milliseconds.
 *
 * Field 22 of /proc/<pid>/stat counts clock ticks since boot. The comm field
 * before it may contain spaces and brackets, so the line is split after its
 * last `)` rather than on whitespace.
 */
async function startedAt(path: string, bootMs: number | null): Promise<number | null> {
  if (bootMs === null) return null;

  const stat = await read(path);
  if (stat === null) return null;

  const after = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  // Field 22 overall; the slice above dropped pid and comm, so it is index 19.
  const ticks = Number(after[19]);
  if (!Number.isFinite(ticks)) return null;

  // 100 Hz is USER_HZ on every Linux this runs on; it is a compile-time
  // constant of the kernel, not something /proc reports.
  return bootMs + (ticks / 100) * 1000;
}
