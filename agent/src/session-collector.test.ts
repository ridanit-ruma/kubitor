import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionCollector, sessionModeFrom } from './session-collector.js';

const NOW = 1_756_800_000_000;
const BOOT = 1_788_685_480;

let root: string;
let procRoot: string;
let logPath: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kubitor-sessions-'));
  procRoot = join(root, 'proc');
  mkdirSync(procRoot);
  writeFileSync(join(procRoot, 'stat'), `btime ${BOOT}\n`);
  for (const pid of [2, 3, 4]) {
    mkdirSync(join(procRoot, String(pid)));
    writeFileSync(join(procRoot, String(pid), 'cmdline'), 'bash');
    writeFileSync(
      join(procRoot, String(pid), 'stat'),
      `${pid} (bash) S ${Array.from({ length: 30 }, () => '0').join(' ')}`,
    );
  }

  logPath = join(root, 'auth.log');
  writeFileSync(logPath, '');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function sshd(pid: number, title: string): void {
  const dir = join(procRoot, String(pid));
  mkdirSync(dir);
  writeFileSync(join(dir, 'cmdline'), title.replaceAll(' ', '\0'));
  const after = Array.from({ length: 30 }, () => '0');
  after[18] = '1000';
  writeFileSync(join(dir, 'stat'), `${pid} (sshd) S ${after.join(' ')}`);
}

function child(pid: number, ppid: number, comm: string, cmdline: string[] = [comm]): void {
  const dir = join(procRoot, String(pid));
  mkdirSync(dir);
  writeFileSync(join(dir, 'cmdline'), `${cmdline.join('\0')}\0`);
  const afterState = Array.from({ length: 30 }, () => '0');
  afterState[0] = String(ppid);
  afterState[18] = '1000';
  writeFileSync(join(dir, 'stat'), `${pid} (${comm}) S ${afterState.join(' ')}`);
}

function collector(mode: 'off' | 'access' | 'full' = 'full', withLog = true) {
  return new SessionCollector({
    node: 'ken',
    mode,
    authLogPath: withLog ? logPath : null,
    procRoot,
    now: () => NOW,
  });
}

describe('sessionModeFrom', () => {
  /** This is a feature people are subject to. It is off unless asked for. */
  it('is off for anything that is not a mode', () => {
    expect(sessionModeFrom(undefined)).toBe('off');
    expect(sessionModeFrom('')).toBe('off');
    expect(sessionModeFrom('yes')).toBe('off');
    expect(sessionModeFrom('access')).toBe('access');
    expect(sessionModeFrom('full')).toBe('full');
  });
});

describe('SessionCollector', () => {
  it('reads nothing at all when it is off', async () => {
    sshd(500, 'sshd: ruma@pts/0');
    appendFileSync(logPath, 'sshd[1]: Accepted publickey for a from 192.0.2.1 port 1 ssh2\n');

    const collection = await collector('off').collect();

    expect(collection).toEqual({
      access: [],
      sessions: [],
      commands: [],
      sessionsProblem: null,
      accessAvailable: false,
    });
  });

  it('reports who is logged in, filed under this machine', async () => {
    sshd(500, 'sshd: ruma@pts/0');

    const { sessions } = await collector().collect();

    expect(sessions).toEqual([
      {
        observed_at: NOW,
        node: 'ken',
        user: 'ruma',
        tty: 'pts/0',
        kind: 'shell',
        pid: 500,
        since: BOOT * 1000 + 10_000,
        from_ip: null,
      },
    ]);
  });

  /**
   * Importing a whole log on every restart would backdate thousands of
   * attempts that had already been recorded.
   */
  it('reads nothing on its first look at the log', async () => {
    appendFileSync(logPath, 'sshd[1]: Accepted publickey for a from 192.0.2.1 port 1 ssh2\n');

    const { access, accessAvailable } = await collector().collect();

    expect(access).toEqual([]);
    expect(accessAvailable).toBe(true);
  });

  it('reads what arrived since the last look', async () => {
    const reading = collector();
    await reading.collect();

    appendFileSync(
      logPath,
      'sshd[42]: Failed password for invalid user admin from 198.51.100.7 port 1 ssh2\n',
    );
    const { access } = await reading.collect();

    expect(access).toEqual([
      {
        at: NOW,
        node: 'ken',
        outcome: 'invalid_user',
        method: 'password',
        user: 'admin',
        client_ip: '198.51.100.7',
        client_port: 1,
        sshd_pid: 42,
      },
    ]);
  });

  /** logrotate replaces the file underneath a long-running agent. */
  it('starts over when the log is rotated out from under it', async () => {
    const reading = collector();
    appendFileSync(logPath, `${'x'.repeat(500)}\n`);
    await reading.collect();

    writeFileSync(logPath, 'sshd[7]: Accepted publickey for a from 192.0.2.1 port 1 ssh2\n');
    const { access } = await reading.collect();

    // The offset reset, so this read establishes a new one rather than
    // replaying a file it has already passed.
    expect(access).toEqual([]);

    appendFileSync(logPath, 'sshd[8]: Accepted publickey for b from 192.0.2.2 port 2 ssh2\n');
    expect((await reading.collect()).access.map((row) => row.user)).toEqual(['b']);
  });

  /**
   * Inside a pod the sessions are readable and the log is not. Saying "nobody
   * has tried to log in" would be a lie the screen could not walk back.
   */
  it('says attempts are unavailable when there is no log to read', async () => {
    sshd(500, 'sshd: ruma@pts/0');

    const collection = await collector('full', false).collect();

    expect(collection.accessAvailable).toBe(false);
    expect(collection.sessions).toHaveLength(1);
  });

  /**
   * "Who is on the machine" and "what they are typing" are different things to
   * agree to, and the second must not arrive as a side effect of the first.
   */
  it('records no commands in access mode, only who is connected', async () => {
    sshd(500, 'sshd: ruma@pts/0');
    child(501, 500, 'bash');

    const collection = await collector('access').collect();

    expect(collection.sessions).toHaveLength(1);
    expect(collection.commands).toEqual([]);
  });

  it('records what runs inside a session in full mode', async () => {
    sshd(500, 'sshd: ruma@pts/0');
    child(501, 500, 'bash');
    child(502, 501, 'kubectl', ['kubectl', 'get', 'pods']);

    const { commands } = await collector('full').collect();

    expect(commands.map((c) => c.comm)).toEqual(['bash', 'kubectl']);
    expect(commands.every((c) => c.source === 'sampled')).toBe(true);
    expect(commands.every((c) => c.user === 'ruma')).toBe(true);
  });

  /** A row per second per open shell is a table nobody can read. */
  it('reports a command once, not on every sample', async () => {
    sshd(500, 'sshd: ruma@pts/0');
    child(501, 500, 'bash');

    const reading = collector('full');
    expect((await reading.collect()).commands).toHaveLength(1);
    expect((await reading.collect()).commands).toEqual([]);
  });

  it('redacts before the row leaves the machine', async () => {
    sshd(500, 'sshd: ruma@pts/0');
    child(501, 500, 'mysql', ['mysql', '--password=hunter2']);

    const { commands } = await collector('full').collect();

    expect(commands[0]?.argv).not.toContain('hunter2');
    expect(commands[0]?.argv).toContain('redacted');
  });

  it('passes on why sessions could not be read', async () => {
    const alone = new SessionCollector({
      node: 'ken',
      mode: 'full',
      authLogPath: null,
      procRoot: join(root, 'nowhere'),
      now: () => NOW,
    });

    expect((await alone.collect()).sessionsProblem).toBe('unreadable');
  });
});
