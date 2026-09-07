/**
 * Takes the secrets out of a command line before it leaves the machine.
 *
 * This runs on the host, before the row is sent, and that placement is the
 * whole point: redacting server-side would be too late, because by then the
 * secret has been through a request body, a log line and another machine's
 * memory. What is removed here was never anywhere else.
 *
 * The list below is not a claim to catch everything. It catches the shapes
 * people actually type, and `comm`-only mode exists for anybody who would
 * rather not rely on a list at all.
 */
const MARKER = '<redacted>';

/**
 * Flags whose value is a secret, in the two forms people write them.
 *
 * `--password=x` and `--password x` are both common, so both are handled; the
 * second means the *following* argument disappears too.
 */
const SECRET_FLAG =
  /^(-{1,2})(p|pass|passwd|password|token|api-?key|apikey|secret|auth|credential|bearer|access-?key|private-?key)$/i;

/** The joined form, `--password=hunter2`, and mysql's notorious `-phunter2`. */
const SECRET_ASSIGNMENT =
  /^(-{1,2})(p|pass|passwd|password|token|api-?key|apikey|secret|auth|credential|bearer|access-?key|private-?key)=(.*)$/i;
const MYSQL_PASSWORD = /^-p(.+)$/;

/** `FOO_TOKEN=...`, which is how a secret reaches a process from a shell. */
const SECRET_ENV =
  /^([A-Za-z_][A-Za-z0-9_]*(?:PASSWORD|TOKEN|SECRET|KEY|CREDENTIAL)[A-Za-z0-9_]*)=(.*)$/;

/** `Authorization: Bearer ...`, whichever way it was quoted. */
const AUTH_HEADER = /^(authorization:\s*\S+\s+).+$/i;

/**
 * A long run of the characters keys are made of.
 *
 * The catch-all for a secret in a shape nobody predicted. The threshold is high
 * enough that paths, hashes in image tags and ordinary words are left alone —
 * a redactor that ate half of every command line would make the feature
 * useless, which is its own kind of failure.
 */
const HIGH_ENTROPY = /^[A-Za-z0-9+/_-]{32,}={0,2}$/;

/** A URL with credentials in it: `postgres://user:pass@host/db`. */
const URL_CREDENTIALS = /^([a-z][a-z0-9+.-]*:\/\/[^:/@\s]+:)[^@/\s]+(@)/i;

export function redactArgv(argv: readonly string[]): string[] {
  const out: string[] = [];
  let swallowNext = false;

  for (const raw of argv) {
    if (swallowNext) {
      swallowNext = false;
      out.push(MARKER);
      continue;
    }

    if (SECRET_FLAG.test(raw)) {
      out.push(raw);
      swallowNext = true;
      continue;
    }

    out.push(redactArgument(raw));
  }

  return out;
}

function redactArgument(argument: string): string {
  const assigned = SECRET_ASSIGNMENT.exec(argument);
  if (assigned) return `${assigned[1]}${assigned[2]}=${MARKER}`;

  const env = SECRET_ENV.exec(argument);
  if (env) return `${env[1]}=${MARKER}`;

  const header = AUTH_HEADER.exec(argument);
  if (header) return `${header[1]}${MARKER}`;

  const url = URL_CREDENTIALS.exec(argument);
  if (url) return argument.replace(URL_CREDENTIALS, `$1${MARKER}$2`);

  // `-phunter2` only after the general forms, so `-p` alone is left to the
  // flag rule above and a bare `-print` is not mistaken for a password.
  const mysql = MYSQL_PASSWORD.exec(argument);
  if (mysql && !argument.startsWith('--') && HIGH_ENTROPY_ISH.test(mysql[1] as string)) {
    return `-p${MARKER}`;
  }

  if (HIGH_ENTROPY.test(argument)) return MARKER;

  return argument;
}

/**
 * Looser than HIGH_ENTROPY, for a value already known to follow `-p`.
 *
 * `-print` and `-pretty` are ordinary flags of other programs; a password
 * glued to `-p` is not a word.
 */
const HIGH_ENTROPY_ISH = /[0-9!@#$%^&*()_+=[\]{};:,.<>?~-]|^[A-Za-z]{0,3}$|[A-Z].*[a-z].*[0-9]/;

/** The marker, exported so a screen can explain what it is looking at. */
export const REDACTED = MARKER;
