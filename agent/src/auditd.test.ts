import { describe, expect, it } from 'vitest';
import { parseAuditLines } from './auditd.js';

const SYSCALL =
  'type=SYSCALL msg=audit(1788685480.123:456): arch=c000003e syscall=59 success=yes exit=0 ' +
  'ppid=1234 pid=1235 auid=1000 uid=1000 gid=1000 ses=3 comm="kubectl" ' +
  'exe="/usr/bin/kubectl" key="kubitor"';

describe('parseAuditLines', () => {
  /**
   * Two record types carry one execution between them: SYSCALL has who and
   * where, EXECVE has what, and they are joined by the event id.
   */
  it('joins a syscall to its arguments', () => {
    const commands = parseAuditLines([
      SYSCALL,
      'type=EXECVE msg=audit(1788685480.123:456): argc=3 a0="kubectl" a1="get" a2="pods"',
    ]);

    expect(commands).toEqual([
      {
        at: 1_788_685_480_123,
        auditSession: 3,
        loginUid: 1000,
        pid: 1235,
        comm: 'kubectl',
        argv: ['kubectl', 'get', 'pods'],
      },
    ]);
  });

  /**
   * auditd hex-encodes an argument whenever it contains anything awkward.
   * Reading that backwards turns every command with a space in it into digits.
   */
  it('decodes a hex-encoded argument', () => {
    const [command] = parseAuditLines([
      SYSCALL,
      'type=EXECVE msg=audit(1788685480.123:456): argc=2 a0="git" a1=636F6D6D6974206D65',
    ]);

    expect(command?.argv).toEqual(['git', 'commit me']);
  });

  it('keeps a quoted argument literal even when it looks like hex', () => {
    const [command] = parseAuditLines([
      SYSCALL,
      'type=EXECVE msg=audit(1788685480.123:456): argc=2 a0="git" a1="abcdef"',
    ]);

    expect(command?.argv).toEqual(['git', 'abcdef']);
  });

  it('takes the millisecond from the event id', () => {
    const [command] = parseAuditLines([
      SYSCALL,
      'type=EXECVE msg=audit(1788685480.123:456): argc=1 a0="ls"',
    ]);

    expect(command?.at).toBe(1_788_685_480_123);
  });

  /** A daemon has no login behind it, and auditd says so with a sentinel. */
  it('reads an unset login session as no session', () => {
    const [command] = parseAuditLines([
      SYSCALL.replace('ses=3', 'ses=4294967295').replace('auid=1000', 'auid=4294967295'),
      'type=EXECVE msg=audit(1788685480.123:456): argc=1 a0="cron"',
    ]);

    expect(command?.auditSession).toBeNull();
    expect(command?.loginUid).toBeNull();
  });

  it('keeps two concurrent executions apart', () => {
    const commands = parseAuditLines([
      SYSCALL,
      SYSCALL.replace('1788685480.123:456', '1788685480.124:457').replace('pid=1235', 'pid=9999'),
      'type=EXECVE msg=audit(1788685480.124:457): argc=1 a0="whoami"',
      'type=EXECVE msg=audit(1788685480.123:456): argc=1 a0="kubectl"',
    ]);

    expect(commands.map((c) => [c.pid, c.argv[0]])).toEqual([
      [9999, 'whoami'],
      [1235, 'kubectl'],
    ]);
  });

  /** An operator with other rules will have other syscalls in the same file. */
  it('ignores syscalls that are not executions', () => {
    expect(
      parseAuditLines([
        SYSCALL.replace('syscall=59', 'syscall=257'),
        'type=EXECVE msg=audit(1788685480.123:456): argc=1 a0="ls"',
      ]),
    ).toEqual([]);
  });

  /**
   * A chunk that splits a pair loses that execution rather than corrupting the
   * next chunk's, which is why nothing is carried between calls.
   */
  it('drops a syscall whose arguments are in the next chunk', () => {
    expect(parseAuditLines([SYSCALL])).toEqual([]);
  });

  it('ignores an EXECVE it never saw the syscall for', () => {
    expect(parseAuditLines(['type=EXECVE msg=audit(1788685480.123:456): argc=1 a0="ls"'])).toEqual(
      [],
    );
  });

  it('ignores everything that is not an audit record', () => {
    expect(parseAuditLines(['', 'not an audit line', 'type=DAEMON_START ver=3.0'])).toEqual([]);
  });
});
