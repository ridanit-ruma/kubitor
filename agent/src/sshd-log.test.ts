import { describe, expect, it } from 'vitest';
import { parseSshdLine } from './sshd-log.js';

describe('parseSshdLine', () => {
  it('reads a successful key login', () => {
    const line =
      'Sep  7 01:02:03 ken sshd[4242]: Accepted publickey for ruma from 192.0.2.10 port 54321 ssh2: ED25519 SHA256:abc';

    expect(parseSshdLine(line)).toEqual({
      outcome: 'accepted',
      method: 'publickey',
      user: 'ruma',
      clientIp: '192.0.2.10',
      clientPort: 54321,
      sshdPid: 4242,
    });
  });

  it('reads a password that was wrong', () => {
    const line = 'sshd[99]: Failed password for ruma from 192.0.2.10 port 1 ssh2';

    expect(parseSshdLine(line)).toMatchObject({
      outcome: 'failed',
      method: 'password',
      user: 'ruma',
    });
  });

  /**
   * A different thing from somebody getting their own password wrong: this is
   * guessing at account names, and an operator reads the two differently.
   */
  it('separates a guessed account name from a wrong password', () => {
    const guessed = parseSshdLine(
      'sshd[99]: Failed password for invalid user admin from 192.0.2.10 port 1 ssh2',
    );

    expect(guessed?.outcome).toBe('invalid_user');
    expect(guessed?.user).toBe('admin');
  });

  it('reads the standalone invalid-user line too', () => {
    expect(
      parseSshdLine('sshd[99]: Invalid user oracle from 198.51.100.7 port 2222'),
    ).toMatchObject({ outcome: 'invalid_user', user: 'oracle', clientIp: '198.51.100.7' });
  });

  it('reads a disconnection, with and without a user', () => {
    expect(
      parseSshdLine('sshd[99]: Disconnected from user ruma 192.0.2.10 port 54321'),
    ).toMatchObject({ outcome: 'disconnected', user: 'ruma' });

    expect(parseSshdLine('sshd[99]: Disconnected from 192.0.2.10 port 54321')).toMatchObject({
      outcome: 'disconnected',
      user: '',
    });
  });

  /** OpenSSH 9.8 split the daemon; the pid is still what ties this together. */
  it('finds the pid whichever binary logged it', () => {
    for (const comm of ['sshd', 'sshd-session', 'sshd-auth']) {
      const parsed = parseSshdLine(
        `${comm}[7]: Accepted publickey for a from 192.0.2.1 port 1 ssh2`,
      );
      expect(parsed?.sshdPid, comm).toBe(7);
    }
  });

  it('takes the method before its submethod', () => {
    expect(
      parseSshdLine('sshd[9]: Failed keyboard-interactive/pam for a from 192.0.2.1 port 1 ssh2')
        ?.method,
    ).toBe('keyboard-interactive');
  });

  /**
   * Most of what sshd logs is not an attempt. A parser that guessed at the
   * rest would fill a screen with rows nobody can act on.
   */
  it('skips everything that is not an attempt', () => {
    const noise = [
      'sshd[1]: Server listening on 0.0.0.0 port 22.',
      'sshd[1]: Received SIGHUP; restarting.',
      'sshd[4242]: pam_unix(sshd:session): session opened for user ruma',
      'sshd[4242]: debug1: kex: algorithm: curve25519-sha256',
      'level=info msg="something else entirely"',
      '',
    ];

    for (const line of noise) expect(parseSshdLine(line), line).toBeNull();
  });
});
