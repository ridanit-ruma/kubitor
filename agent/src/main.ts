import { readFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { createHostCollector } from './reading.js';
import { Sender } from './sender.js';

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

async function main(): Promise<void> {
  const server = required('KUBITOR_SERVER_URL').replace(/\/+$/, '');
  const node = process.env.KUBITOR_NODE_NAME ?? hostname();
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
  console.log(`kubitor agent reporting ${node} to ${server} every ${INTERVAL_MS}ms`);

  let lastComplaint = 0;

  while (running) {
    try {
      sender.enqueue(await collect(Date.now()));

      const result = await sender.flush();
      // Once a second is too often to log a failure every time; say it at most
      // once a minute so a long outage leaves a readable trail, not a flood.
      if (!result.advance && result.status !== null && Date.now() - lastComplaint > 60_000) {
        lastComplaint = Date.now();
        console.warn(`server answered ${result.status}; holding ${sender.pending} rows`);
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
