import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { redactArgv } from './redact.js';

/**
 * What is running inside a session, sampled from /proc.
 *
 * Sampled, not recorded. This walks the process tree under each session once a
 * second and reports what it finds, which means **anything shorter than the
 * interval is missed** — and that is most commands. Every row says so in its
 * `source`, and every screen showing them says it in words, because a list that
 * looks complete and is not is worse than no list: an operator will conclude
 * something from its absences.
 *
 * The complete alternative is auditd, which sees every `execve`. It is a
 * separate thing to install and configure, and where it is present the same
 * screen gets `source: 'audit'` rows and says so.
 */
export interface RunningCommand {
  /** The session this belongs to, which is the sshd process the shell hangs off. */
  sessionPid: number;
  pid: number;
  comm: string;
  /** Redacted before it left the machine. Empty for a kernel thread. */
  argv: string[];
  startedAt: number;
}

export interface CommandsOptions {
  /** Session pids to walk beneath, from the session reader. */
  sessionPids: readonly number[];
  procRoot?: string;
  /** Record the program only, never its arguments. */
  commOnly?: boolean;
}

interface ProcessEntry {
  pid: number;
  ppid: number;
  comm: string;
  startTicks: number;
}

/**
 * Every process descended from one of the given sessions.
 *
 * One pass over /proc, then a walk down the parent links, so a machine with
 * three thousand processes is read once rather than once per session.
 */
export async function readSessionCommands(
  options: CommandsOptions,
  bootMs: number | null,
): Promise<RunningCommand[]> {
  const root = options.procRoot ?? '/proc';
  if (options.sessionPids.length === 0 || bootMs === null) return [];

  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return [];
  }

  const processes = new Map<number, ProcessEntry>();
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const entry = await readEntry(root, Number(name));
    if (entry) processes.set(entry.pid, entry);
  }

  const sessions = new Set(options.sessionPids);
  const owner = new Map<number, number>();

  // Walk up from each process rather than down from each session: the parent
  // link is what /proc gives, and a bounded climb per process is cheaper than
  // building a child index for a tree that is mostly not ours.
  for (const entry of processes.values()) {
    const session = sessionOf(entry, processes, sessions);
    if (session !== null) owner.set(entry.pid, session);
  }

  const commands: RunningCommand[] = [];
  for (const [pid, sessionPid] of owner) {
    // The session process itself is the session, not something run inside it.
    if (sessions.has(pid)) continue;

    const entry = processes.get(pid);
    if (!entry) continue;

    const argv = options.commOnly ? [] : await readArgv(root, pid);

    commands.push({
      sessionPid,
      pid,
      comm: entry.comm,
      argv,
      startedAt: bootMs + (entry.startTicks / 100) * 1000,
    });
  }

  return commands.sort((a, b) => a.startedAt - b.startedAt || a.pid - b.pid);
}

/** The session a process belongs to, or null if it belongs to none. */
function sessionOf(
  entry: ProcessEntry,
  processes: Map<number, ProcessEntry>,
  sessions: Set<number>,
): number | null {
  let current: ProcessEntry | undefined = entry;

  // Bounded: a runaway parent chain, or one that has been re-parented into a
  // loop by a race with process exit, must not hang the agent.
  for (let depth = 0; depth < 32 && current; depth += 1) {
    if (sessions.has(current.pid)) return current.pid;
    if (current.ppid <= 1) return null;
    current = processes.get(current.ppid);
  }

  return null;
}

async function readEntry(root: string, pid: number): Promise<ProcessEntry | null> {
  const stat = await read(join(root, String(pid), 'stat'));
  if (stat === null) return null;

  const open = stat.indexOf('(');
  const close = stat.lastIndexOf(')');
  if (open === -1 || close === -1) return null;

  const comm = stat.slice(open + 1, close);
  const after = stat.slice(close + 2).split(' ');

  const ppid = Number(after[1]);
  const startTicks = Number(after[19]);
  if (!Number.isFinite(ppid) || !Number.isFinite(startTicks)) return null;

  return { pid, ppid, comm, startTicks };
}

async function readArgv(root: string, pid: number): Promise<string[]> {
  const raw = await read(join(root, String(pid), 'cmdline'));
  if (raw === null) return [];

  const argv = raw.split('\0').filter((part) => part !== '');
  // Redacted here, on the machine, before the row exists anywhere else.
  return redactArgv(argv);
}

async function read(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

/**
 * What is new since the last sample.
 *
 * Emitting the whole tree every second would write a row per second per open
 * shell, which is a table nobody can read and a volume nobody wants. A process
 * is news once; after that it is the same process still running.
 */
export class CommandDiff {
  #seen = new Set<string>();

  /** Keyed by pid and start time, so a reused pid is a different process. */
  static key(command: RunningCommand): string {
    return `${command.pid}:${Math.round(command.startedAt)}`;
  }

  next(commands: readonly RunningCommand[]): RunningCommand[] {
    const current = new Set(commands.map((command) => CommandDiff.key(command)));
    const fresh = commands.filter((command) => !this.#seen.has(CommandDiff.key(command)));

    // Only what is still running is remembered, so the set cannot grow without
    // bound on a machine that has been up for months.
    this.#seen = current;
    return fresh;
  }
}
