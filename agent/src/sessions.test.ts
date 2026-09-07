import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readSessions } from './sessions.js';

const BOOT = 1_788_685_480;

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kubitor-proc-'));
  writeFileSync(join(root, 'stat'), `cpu  1 2 3\nbtime ${BOOT}\n`);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/**
 * A process as /proc presents one.
 *
 * `stat` is `pid (comm) state` and then the numeric fields from ppid onwards,
 * so field 22 — starttime, in USER_HZ ticks since boot — is index 18 of what
 * follows the state character.
 */
function process_(pid: number, cmdline: string, ticksSinceBoot = 1000): void {
  const dir = join(root, String(pid));
  mkdirSync(dir);
  writeFileSync(join(dir, 'cmdline'), cmdline.replaceAll(' ', '\0'));

  const afterState = Array.from({ length: 30 }, () => '0');
  afterState[18] = String(ticksSinceBoot);
  writeFileSync(join(dir, 'stat'), `${pid} (sshd) S ${afterState.join(' ')}`);
}

/** Enough processes that the reader does not mistake this for a lone pod. */
function crowd(): void {
  for (const pid of [2, 3, 4]) process_(pid, 'bash');
}

describe('readSessions', () => {
  it('finds a login shell and says when it started', async () => {
    crowd();
    process_(91572, 'sshd: ruma@pts/0', 500);

    const reading = await readSessions(root);

    expect(reading.problem).toBeNull();
    expect(reading.sessions).toEqual([
      {
        user: 'ruma',
        tty: 'pts/0',
        kind: 'shell',
        pid: 91572,
        since: BOOT * 1000 + 5000,
        auditSession: null,
      },
    ]);
  });

  /**
   * The privileged monitor is the same login counted twice, and the listener
   * is not a login at all.
   */
  it('ignores the listener and the privileged half', async () => {
    crowd();
    process_(812, 'sshd: /usr/sbin/sshd [listener] 0 of 10-100 startups');
    process_(91566, 'sshd: attacca [priv]');
    process_(91572, 'sshd: attacca@pts/1');

    const reading = await readSessions(root);

    expect(reading.sessions.map((s) => s.pid)).toEqual([91572]);
  });

  /**
   * `ssh host cmd`, sftp and a bare forward all arrive without a terminal. A
   * list of login shells alone would miss most of what automation does.
   */
  it('counts a session with no terminal', async () => {
    crowd();
    process_(91572, 'sshd: deploy@notty');

    const [session] = (await readSessions(root)).sessions;

    expect(session).toMatchObject({ user: 'deploy', tty: null, kind: 'exec' });
  });

  /**
   * auditd records the login session, not the sshd pid, so this is the only
   * thing that can tie an audited command to the session it was typed in.
   */
  it('reads the login session id where the machine keeps one', async () => {
    crowd();
    process_(91572, 'sshd: ruma@pts/0');
    writeFileSync(join(root, '91572', 'sessionid'), '3\n');

    expect((await readSessions(root)).sessions[0]?.auditSession).toBe(3);
  });

  it('reads the unset sentinel as no login session', async () => {
    crowd();
    process_(91572, 'sshd: ruma@pts/0');
    writeFileSync(join(root, '91572', 'sessionid'), '4294967295\n');

    expect((await readSessions(root)).sessions[0]?.auditSession).toBeNull();
  });

  it('reads the newer split daemon too', async () => {
    crowd();
    process_(91572, 'sshd-session: ruma@pts/0');

    expect((await readSessions(root)).sessions.map((s) => s.user)).toEqual(['ruma']);
  });

  it('orders by when they started, oldest first', async () => {
    crowd();
    process_(300, 'sshd: c@pts/2', 3000);
    process_(100, 'sshd: a@pts/0', 1000);
    process_(200, 'sshd: b@pts/1', 2000);

    expect((await readSessions(root)).sessions.map((s) => s.user)).toEqual(['a', 'b', 'c']);
  });

  it('reports nobody logged in as nobody logged in', async () => {
    crowd();

    expect(await readSessions(root)).toEqual({ sessions: [], problem: null });
  });

  /**
   * An empty list and "I am not allowed to look" are different answers, and
   * showing the second as the first is how a screen quietly lies. A pod without
   * hostPID sees only itself.
   */
  it('says so when it is looking at its own namespace, not the host', async () => {
    process_(1, 'node');

    const reading = await readSessions(root);

    expect(reading.sessions).toEqual([]);
    expect(reading.problem).toBe('no-host-pids');
  });

  it('says so when it cannot read any process title at all', async () => {
    for (const pid of [2, 3, 4, 5]) mkdirSync(join(root, String(pid)));

    expect((await readSessions(root)).problem).toBe('hidepid');
  });

  it('says so when there is no /proc to read', async () => {
    expect(await readSessions(join(root, 'nowhere'))).toEqual({
      sessions: [],
      problem: 'unreadable',
    });
  });

  /** Without btime there is no epoch to convert into, so a row would be a guess. */
  it('skips a session it cannot date', async () => {
    writeFileSync(join(root, 'stat'), 'cpu 1 2 3\n');
    crowd();
    process_(91572, 'sshd: ruma@pts/0');

    expect((await readSessions(root)).sessions).toEqual([]);
  });
});
