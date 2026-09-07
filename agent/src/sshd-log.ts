/**
 * What sshd says about who tried to get in.
 *
 * Parsed from its log rather than from anything sshd offers deliberately,
 * because it offers nothing else: there is no socket, no file and no API that
 * reports authentication attempts. The lines below are stable across OpenSSH
 * versions in the parts that matter, and anything unrecognised is skipped
 * rather than guessed at.
 */
export type Outcome = 'accepted' | 'failed' | 'invalid_user' | 'disconnected';

export type Method = 'publickey' | 'password' | 'keyboard-interactive' | 'none';

export interface AccessAttempt {
  outcome: Outcome;
  method: Method;
  /** The account named, which for `invalid_user` is one that does not exist. */
  user: string;
  clientIp: string;
  clientPort: number | null;
  /** sshd's pid for this connection, which ties an attempt to a session. */
  sshdPid: number | null;
}

const METHODS: Record<string, Method> = {
  publickey: 'publickey',
  password: 'password',
  'keyboard-interactive': 'keyboard-interactive',
  none: 'none',
};

function method(word: string | undefined): Method {
  if (!word) return 'none';
  // `keyboard-interactive/pam` and friends carry a submethod after a slash.
  return METHODS[word.split('/')[0] as string] ?? 'none';
}

/**
 * One log line, or null if it is not about an attempt.
 *
 * Most of what sshd logs is not — configuration reloads, session teardown
 * chatter, key exchange detail — and a parser that guessed at those would fill
 * the screen with rows nobody can act on.
 */
export function parseSshdLine(line: string): AccessAttempt | null {
  const pid = /sshd(?:-session|-auth)?\[(\d+)\]/.exec(line);
  const sshdPid = pid ? Number(pid[1]) : null;

  // Accepted publickey for ruma from 192.0.2.10 port 54321 ssh2: ED25519 SHA256:...
  const accepted = /Accepted (\S+) for (\S+) from (\S+) port (\d+)/.exec(line);
  if (accepted) {
    return {
      outcome: 'accepted',
      method: method(accepted[1]),
      user: accepted[2] as string,
      clientIp: accepted[3] as string,
      clientPort: Number(accepted[4]),
      sshdPid,
    };
  }

  // Failed password for invalid user admin from 192.0.2.10 port 54321 ssh2
  //
  // The "invalid user" form matters on its own: it is somebody guessing at
  // account names, which is a different thing from somebody getting their own
  // password wrong, and an operator reads the two differently.
  const failed = /Failed (\S+) for (invalid user )?(\S+) from (\S+) port (\d+)/.exec(line);
  if (failed) {
    return {
      outcome: failed[2] ? 'invalid_user' : 'failed',
      method: method(failed[1]),
      user: failed[3] as string,
      clientIp: failed[4] as string,
      clientPort: Number(failed[5]),
      sshdPid,
    };
  }

  // Invalid user admin from 192.0.2.10 port 54321
  const invalid = /Invalid user (\S+) from (\S+) port (\d+)/.exec(line);
  if (invalid) {
    return {
      outcome: 'invalid_user',
      method: 'none',
      user: invalid[1] as string,
      clientIp: invalid[2] as string,
      clientPort: Number(invalid[3]),
      sshdPid,
    };
  }

  // Disconnected from user ruma 192.0.2.10 port 54321
  const disconnected = /Disconnected from (?:user (\S+) )?(\S+) port (\d+)/.exec(line);
  if (disconnected) {
    return {
      outcome: 'disconnected',
      method: 'none',
      user: disconnected[1] ?? '',
      clientIp: disconnected[2] as string,
      clientPort: Number(disconnected[3]),
      sshdPid,
    };
  }

  return null;
}
