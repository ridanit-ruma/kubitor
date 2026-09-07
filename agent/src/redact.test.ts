import { describe, expect, it } from 'vitest';
import { REDACTED, redactArgv } from './redact.js';

const redact = (line: string) => redactArgv(line.split(' ')).join(' ');

describe('redactArgv', () => {
  /**
   * The shapes people actually type. Each of these has put a password into
   * somebody's shell history, and would put one into this database.
   */
  it('takes the value out of a joined secret flag', () => {
    expect(redact('curl --token=abc123 https://example.com')).toBe(
      `curl --token=${REDACTED} https://example.com`,
    );
    expect(redact('psql --password=hunter2')).toBe(`psql --password=${REDACTED}`);
  });

  it('takes the argument after a separated secret flag', () => {
    expect(redact('mycli --password hunter2 --host db')).toBe(
      `mycli --password ${REDACTED} --host db`,
    );
  });

  /** mysql's notorious form, where the value is glued to the flag. */
  it('takes mysql-style -pSECRET', () => {
    expect(redact('mysql -uroot -pS3cr3t! mydb')).toBe(`mysql -uroot -p${REDACTED} mydb`);
  });

  it('takes a secret out of an environment assignment', () => {
    expect(redact('env GITHUB_TOKEN=ghp_abcdefghijklmnop deploy')).toBe(
      `env GITHUB_TOKEN=${REDACTED} deploy`,
    );
    expect(redact('AWS_SECRET_ACCESS_KEY=wJalrXUt aws s3 ls')).toBe(
      `AWS_SECRET_ACCESS_KEY=${REDACTED} aws s3 ls`,
    );
  });

  it('keeps the scheme of an authorization header and drops the credential', () => {
    expect(redactArgv(['curl', '-H', 'Authorization: Bearer eyJhbGciOi.abc.def'])).toEqual([
      'curl',
      '-H',
      `Authorization: Bearer ${REDACTED}`,
    ]);
  });

  it('takes the password out of a connection URL, leaving the rest readable', () => {
    expect(redact('psql postgres://kubitor:hunter2@db.internal:5432/kubitor')).toBe(
      `psql postgres://kubitor:${REDACTED}@db.internal:5432/kubitor`,
    );
  });

  /** The catch-all, for a secret in a shape nobody predicted. */
  it('drops a long run of key-shaped characters', () => {
    expect(redact('deploy ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8')).toBe(`deploy ${REDACTED}`);
  });

  /**
   * The other failure. A redactor that ate half of every command line would
   * make the whole feature useless, which is its own kind of broken.
   */
  it('leaves an ordinary command line alone', () => {
    const ordinary = [
      'kubectl get pods -n kubitor',
      'systemctl restart kubitor-agent',
      'tail -f /var/log/auth.log',
      'find . -name *.ts -print',
      'git commit -m fix the thing',
      'docker run --rm -it alpine sh',
      'nixos-rebuild switch --flake .#ken',
    ];

    for (const line of ordinary) expect(redact(line), line).toBe(line);
  });

  it('leaves a path alone however long it is', () => {
    const path = '/home/ruma/kubitor/server/src/integrations/host-agent/index.ts';
    expect(redact(`cat ${path}`)).toBe(`cat ${path}`);
  });

  it('leaves an image tag alone', () => {
    const image = 'ghcr.io/ridanit-ruma/kubitor-server:sha-7fbb19036af2c971c539be7373b348a9';
    expect(redact(`docker pull ${image}`)).toBe(`docker pull ${image}`);
  });

  it('redacts the argument after a flag even when it looks harmless', () => {
    expect(redact('login --password x')).toBe(`login --password ${REDACTED}`);
  });

  it('handles an empty command line', () => {
    expect(redactArgv([])).toEqual([]);
  });
});
