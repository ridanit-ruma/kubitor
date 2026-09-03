import { hostname } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { readHardware } from './hwmon.js';
import { Sender } from './sender.js';

/**
 * The optional half of kubitor.
 *
 * Everything the API server can answer is collected by the server itself. This
 * exists only for facts that need the host: temperatures, clocks, and later GPU
 * and disk health. A cluster without it is complete, just shallower.
 */
const INTERVAL_MS = Number(process.env.KUBITOR_AGENT_INTERVAL_MS ?? 15_000);
const MAX_BUFFERED = Number(process.env.KUBITOR_AGENT_MAX_BUFFERED ?? 240);

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`${name} is required`);
    process.exit(1);
  }
  return value;
}

async function main(): Promise<void> {
  const server = required('KUBITOR_SERVER_URL').replace(/\/+$/, '');
  const token = required('KUBITOR_AGENT_TOKEN');
  const node = process.env.KUBITOR_NODE_NAME ?? hostname();

  const sender = new Sender({
    endpoint: `${server}/api/ingest/hardware`,
    token,
    maxBuffered: MAX_BUFFERED,
  });

  let running = true;
  const stop = (): void => {
    running = false;
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);

  console.log(`kubitor agent reporting ${node} to ${server} every ${INTERVAL_MS}ms`);

  while (running) {
    try {
      const reading = await readHardware();
      sender.enqueue({
        at: Date.now(),
        node,
        cpu_mhz: reading.cpuMhz,
        temps: reading.temps,
      });

      const result = await sender.flush();
      if (!result.advance && result.status !== null) {
        console.warn(`server answered ${result.status}; retrying ${sender.pending} rows`);
      }
    } catch (error) {
      // A bad cycle must not end the process: the next one may work, and a
      // restart loop reports nothing at all.
      console.warn(`collection failed: ${String(error)}`);
    }

    await delay(INTERVAL_MS);
  }
}

await main();
