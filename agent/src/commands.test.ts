import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CommandDiff, type RunningCommand, readSessionCommands } from './commands.js';
import { REDACTED } from './redact.js';

const BOOT = 1_788_685_480_000;

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kubitor-cmd-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function process_(
  pid: number,
  ppid: number,
  comm: string,
  cmdline: string[] = [comm],
  ticks = 1000,
): void {
  const dir = join(root, String(pid));
  mkdirSync(dir);
  writeFileSync(join(dir, 'cmdline'), `${cmdline.join('\0')}\0`);

  // `stat` is `pid (comm) state` and then the numeric fields from ppid on, so
  // ppid is index 0 of what follows the state character and starttime is 18.
  const afterState = Array.from({ length: 30 }, () => '0');
  afterState[0] = String(ppid);
  afterState[18] = String(ticks);
  writeFileSync(join(dir, 'stat'), `${pid} (${comm}) S ${afterState.join(' ')}`);
}

const read = (sessionPids: number[], commOnly = false) =>
  readSessionCommands({ sessionPids, procRoot: root, commOnly }, BOOT);

describe('readSessionCommands', () => {
  it('finds what is running under a session, however deep', async () => {
    process_(1, 0, 'systemd');
    process_(100, 1, 'sshd');
    process_(101, 100, 'bash');
    process_(102, 101, 'kubectl', ['kubectl', 'get', 'pods']);

    const commands = await read([100]);

    expect(commands.map((c) => c.comm)).toEqual(['bash', 'kubectl']);
    expect(commands.every((c) => c.sessionPid === 100)).toBe(true);
  });

  it('leaves everything outside the session alone', async () => {
    process_(1, 0, 'systemd');
    process_(100, 1, 'sshd');
    process_(101, 100, 'bash');
    process_(200, 1, 'nginx');
    process_(201, 200, 'nginx');

    expect((await read([100])).map((c) => c.pid)).toEqual([101]);
  });

  /** The session process is the session, not something run inside it. */
  it('does not report the session as its own command', async () => {
    process_(1, 0, 'systemd');
    process_(100, 1, 'sshd');

    expect(await read([100])).toEqual([]);
  });

  it('attributes each process to its own session', async () => {
    process_(1, 0, 'systemd');
    process_(100, 1, 'sshd');
    process_(200, 1, 'sshd');
    process_(101, 100, 'bash');
    process_(201, 200, 'zsh');

    const commands = await read([100, 200]);
    const owners = Object.fromEntries(commands.map((c) => [c.comm, c.sessionPid]));

    expect(owners).toEqual({ bash: 100, zsh: 200 });
  });

  /** Redacted on the machine, before the row exists anywhere else. */
  it('redacts arguments before they leave', async () => {
    process_(1, 0, 'systemd');
    process_(100, 1, 'sshd');
    process_(101, 100, 'mysql', ['mysql', '--password=hunter2', 'db']);

    const [command] = await read([100]);

    expect(command?.argv).toEqual(['mysql', `--password=${REDACTED}`, 'db']);
  });

  /** For anybody who would rather not rely on a pattern list at all. */
  it('records the program only when asked', async () => {
    process_(1, 0, 'systemd');
    process_(100, 1, 'sshd');
    process_(101, 100, 'mysql', ['mysql', '--password=hunter2', 'db']);

    const [command] = await read([100], true);

    expect(command?.comm).toBe('mysql');
    expect(command?.argv).toEqual([]);
  });

  it('dates a process from the kernel boot time', async () => {
    process_(1, 0, 'systemd');
    process_(100, 1, 'sshd');
    process_(101, 100, 'bash', ['bash'], 250);

    expect((await read([100]))[0]?.startedAt).toBe(BOOT + 2500);
  });

  it('reports nothing when no session is open', async () => {
    process_(1, 0, 'systemd');
    process_(200, 1, 'nginx');

    expect(await read([])).toEqual([]);
  });

  /**
   * A parent chain that loops — a race with process exit can produce one — must
   * not hang the agent.
   */
  it('survives a parent chain that points at itself', async () => {
    process_(1, 0, 'systemd');
    process_(100, 1, 'sshd');
    process_(500, 501, 'a');
    process_(501, 500, 'b');

    await expect(read([100])).resolves.toEqual([]);
  });

  it('says nothing rather than guessing without a boot time', async () => {
    process_(1, 0, 'systemd');
    process_(100, 1, 'sshd');
    process_(101, 100, 'bash');

    expect(await readSessionCommands({ sessionPids: [100], procRoot: root }, null)).toEqual([]);
  });
});

describe('CommandDiff', () => {
  const command = (pid: number, startedAt = 1): RunningCommand => ({
    sessionPid: 100,
    pid,
    comm: 'bash',
    argv: [],
    startedAt,
  });

  /**
   * Emitting the whole tree every second would write a row per second per open
   * shell — a table nobody can read and a volume nobody wants.
   */
  it('reports a process once and then stops', () => {
    const diff = new CommandDiff();

    expect(diff.next([command(1)]).map((c) => c.pid)).toEqual([1]);
    expect(diff.next([command(1)])).toEqual([]);
  });

  it('reports one that has just appeared', () => {
    const diff = new CommandDiff();
    diff.next([command(1)]);

    expect(diff.next([command(1), command(2)]).map((c) => c.pid)).toEqual([2]);
  });

  /** A reused pid is a different process, and is news again. */
  it('tells a reused pid from the process that had it', () => {
    const diff = new CommandDiff();
    diff.next([command(1, 1000)]);

    expect(diff.next([command(1, 5000)]).map((c) => c.startedAt)).toEqual([5000]);
  });

  /** The remembered set must not grow forever on a machine up for months. */
  it('forgets what has exited', () => {
    const diff = new CommandDiff();
    diff.next([command(1), command(2)]);
    diff.next([command(2)]);

    expect(diff.next([command(1)]).map((c) => c.pid)).toEqual([1]);
  });
});
