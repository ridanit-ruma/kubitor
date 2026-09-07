import { readFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { hostNameFrom } from './identity.js';
import { createHostCollector } from './reading.js';
import { deliveryNote, Sender } from './sender.js';
import { SessionCollector, sessionModeFrom } from './session-collector.js';
import { DEFAULT_AFTER_MS, DEFAULT_REPEAT_MS, Witness } from './witness.js';

/**
 * The optional half of kubitor.
 *
 * Everything the API server can answer is collected by the server itself. This
 * exists only for facts that need the host: RAM as the kernel sees it, CPU and
 * GPU clocks, disks, and temperatures. A cluster without it is complete, just
 * shallower.
 *
 * It reports once a second. The server decides how much of that reaches the
 * database — the push cadence and the storage cadence are not the agent's
 * business, and conflating them is what destroys a SQLite file.
 */
const INTERVAL_MS = Number(process.env.KUBITOR_AGENT_INTERVAL_MS ?? 1000);
const MAX_BUFFERED = Number(process.env.KUBITOR_AGENT_MAX_BUFFERED ?? 240);
/**
 * Where the projected service-account token is mounted.
 *
 * Preferred over a static token: the API server signs it, it names the node it
 * was issued on, and there is no secret for anyone to distribute or leak. The
 * kubelet rotates it, so it is re-read rather than remembered.
 */
const SA_TOKEN_PATH = process.env.KUBITOR_SA_TOKEN_PATH ?? '/var/run/secrets/kubitor/token';

/**
 * Where to shout if the server stops answering.
 *
 * Off unless set. kubitor cannot report its own death, and this agent is one
 * of however many processes that can — see witness.ts for why duplicates from
 * several nodes are the point rather than a flaw.
 */
/**
 * Whether this machine reports who is logged into it.
 *
 * `off` by default and off means nothing is read. People are subject to this,
 * so the switch is on the machine being watched rather than on the dashboard
 * watching it.
 */
const SESSION_MODE = sessionModeFrom(process.env.KUBITOR_AGENT_SESSIONS);
/** `/var/log/auth.log` on Debian, `/var/log/secure` on RHEL. */
const AUTH_LOG = process.env.KUBITOR_AGENT_AUTH_LOG ?? null;
/** How often sessions are looked at. They change on a human timescale. */
const SESSION_INTERVAL_MS = Number(process.env.KUBITOR_AGENT_SESSION_INTERVAL_MS ?? 15_000);

const WITNESS_URL = process.env.KUBITOR_AGENT_WITNESS_URL ?? null;
const WITNESS_AFTER_MS = Number(process.env.KUBITOR_AGENT_WITNESS_AFTER_MS ?? DEFAULT_AFTER_MS);
const WITNESS_REPEAT_MS = Number(process.env.KUBITOR_AGENT_WITNESS_REPEAT_MS ?? DEFAULT_REPEAT_MS);

async function main(): Promise<void> {
  const server = required('KUBITOR_SERVER_URL').replace(/\/+$/, '');
  const node = hostNameFrom(process.env, hostname());
  const staticToken = process.env.KUBITOR_AGENT_TOKEN ?? null;

  const readToken = async (): Promise<string | null> => {
    if (staticToken) return staticToken;
    try {
      return (await readFile(SA_TOKEN_PATH, 'utf8')).trim();
    } catch {
      return null;
    }
  };

  if ((await readToken()) === null) {
    console.error(
      `no credential: set KUBITOR_AGENT_TOKEN or mount a projected token at ${SA_TOKEN_PATH}`,
    );
    process.exit(1);
  }

  const sender = new Sender({
    endpoint: `${server}/api/ingest/host`,
    token: readToken,
    maxBuffered: MAX_BUFFERED,
  });

  let running = true;
  const stop = (): void => {
    running = false;
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);

  const collect = createHostCollector(node);

  const sessions = new SessionCollector({
    node,
    mode: SESSION_MODE,
    authLogPath: AUTH_LOG,
    commOnly: process.env.KUBITOR_AGENT_COMMANDS_COMM_ONLY === 'true',
  });

  // Its own sender, and its own endpoints: a burst of login attempts must not
  // delay the once-a-second host reading, and a server that refuses one must
  // not wedge the other.
  const accessSender = new Sender({
    endpoint: `${server}/api/ingest/access`,
    token: readToken,
    maxBuffered: MAX_BUFFERED,
  });
  const commandSender = new Sender({
    endpoint: `${server}/api/ingest/commands`,
    token: readToken,
    maxBuffered: MAX_BUFFERED,
  });

  /**
   * Sessions are posted directly, not through a Sender.
   *
   * A Sender buffers so an outage does not lose readings, which is right for a
   * stream and wrong for a snapshot: the useful thing about "who is logged in"
   * is that it is true now. Replaying a snapshot from five minutes ago would
   * put people back on the screen who had already gone.
   */
  const postSessions = async (rows: Record<string, unknown>[]): Promise<void> => {
    const token = await readToken();
    if (token === null) return;

    try {
      await fetch(`${server}/api/ingest/sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ rows }),
      });
    } catch {
      // The next tick carries a fresh snapshot; there is nothing here worth
      // retrying, and the host reading already reports an unreachable server.
    }
  };

  let lastSessionsAt = 0;
  let lastSessionComplaint = 0;

  const reportSessions = async (): Promise<void> => {
    if (!sessions.enabled) return;

    const now = Date.now();
    if (now - lastSessionsAt < SESSION_INTERVAL_MS) return;
    lastSessionsAt = now;

    const collection = await sessions.collect();

    if (collection.sessionsProblem !== null && now - lastSessionComplaint > 3_600_000) {
      lastSessionComplaint = now;
      console.warn(
        `cannot read sessions (${collection.sessionsProblem}); ` +
          'the agent needs hostPID, and /proc must not be mounted with hidepid',
      );
    }

    if (collection.access.length > 0) {
      for (const row of collection.access) accessSender.enqueue(row);
      await accessSender.flush();
    }

    if (collection.commands.length > 0) {
      for (const row of collection.commands) commandSender.enqueue(row);
      await commandSender.flush();
    }

    // Sent every time, including empty: an empty snapshot is the answer
    // "nobody is logged in here", and withholding it would leave the last
    // session on screen after everybody had gone.
    await postSessions(collection.sessions);
  };
  const witness = new Witness({
    url: WITNESS_URL,
    host: node,
    afterMs: WITNESS_AFTER_MS,
    repeatMs: WITNESS_REPEAT_MS,
    log: (message) => console.warn(message),
  });

  console.log(`kubitor agent reporting ${node} to ${server} every ${INTERVAL_MS}ms`);
  if (sessions.enabled) {
    console.log(
      `sessions: ${SESSION_MODE}${AUTH_LOG ? `, attempts from ${AUTH_LOG}` : ', no auth log configured'}`,
    );
  }
  if (witness.enabled) {
    console.log(`will report the server unreachable to ${WITNESS_URL} after ${WITNESS_AFTER_MS}ms`);
  }

  let lastComplaint = 0;

  while (running) {
    try {
      sender.enqueue(await collect(Date.now()));

      const result = await sender.flush();

      // The server answered something, even a refusal: it is up. Only a
      // missing status means unreachable, which is what the witness is for.
      witness.record(result.status !== null);
      await witness.check();

      // Once a second is too often to log a failure every time; say it at most
      // once a minute so a long outage leaves a readable trail, not a flood.
      await reportSessions();

      const note = deliveryNote(result, sender.pending, server);
      if (note !== null && Date.now() - lastComplaint > 60_000) {
        lastComplaint = Date.now();
        console.warn(note);
      }
    } catch (error) {
      // A bad cycle must not end the process: the next one may work, and a
      // restart loop reports nothing at all.
      console.warn(`collection failed: ${String(error)}`);
    }

    await delay(INTERVAL_MS);
  }
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`${name} is required`);
    process.exit(1);
  }
  return value;
}

await main();
