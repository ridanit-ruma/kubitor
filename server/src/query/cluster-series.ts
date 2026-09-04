import { type Kysely, sql } from 'kysely';
import type { Database } from '../db/schema.js';
import { counterRate } from '../kube/rates.js';

/**
 * What the whole cluster moved, over time.
 *
 * The overview used to draw this from readings the browser had collected since
 * the page opened, so a reload started the chart empty and a rate had nothing
 * behind it. The same readings are already stored per node; this sums them.
 */
export interface ClusterTrafficPoint {
  at: number;
  rxBytesPerSecond: number | null;
  txBytesPerSecond: number | null;
}

/**
 * Traffic across every node, one point per bucket.
 *
 * Summing has to happen after averaging, never before. A bucket wider than the
 * storage interval holds several readings from each node, and adding those
 * together would report a cluster moving five times what it moves. So: average
 * per node inside the bucket, then add the nodes up.
 *
 * The agent's own measurement is preferred because it is what the live figures
 * above the chart use. Where no agent runs, the kubelet's counters answer
 * instead — converted to rates per node, which is the only way a counter can be
 * summed across machines that reset independently.
 */
export async function clusterTraffic(
  db: Kysely<Database>,
  since: number,
  until: number,
  widthMs: number,
): Promise<ClusterTrafficPoint[]> {
  const fromAgent = await agentTraffic(db, since, until, widthMs);
  if (fromAgent.length > 0) return fromAgent;
  return kubeletTraffic(db, since, until, widthMs);
}

/** Fixed-width buckets, in SQL both dialects read the same way. */
function bucketOf(widthMs: number) {
  return sql<number>`at / ${sql.lit(Math.max(1, Math.round(widthMs)))}`;
}

async function agentTraffic(
  db: Kysely<Database>,
  since: number,
  until: number,
  widthMs: number,
): Promise<ClusterTrafficPoint[]> {
  const bucket = bucketOf(widthMs);

  const perNode = db
    .selectFrom('facet_host_hardware')
    .select([
      bucket.as('bucket'),
      'node',
      sql<number>`max(at)`.as('at'),
      sql<number | null>`avg(net_rx_bytes_per_second)`.as('rx'),
      sql<number | null>`avg(net_tx_bytes_per_second)`.as('tx'),
    ])
    .where('at', '>=', since)
    .where('at', '<=', until)
    .groupBy([bucket, 'node']);

  const rows = await db
    .selectFrom(perNode.as('per_node'))
    .select([
      'per_node.bucket',
      sql<number>`max(at)`.as('at'),
      sql<number | null>`sum(rx)`.as('rx'),
      sql<number | null>`sum(tx)`.as('tx'),
    ])
    .groupBy('per_node.bucket')
    .orderBy('per_node.bucket', 'asc')
    .execute();

  return rows.map((row) => ({
    at: Number(row.at),
    rxBytesPerSecond: nullableNumber(row.rx),
    txBytesPerSecond: nullableNumber(row.tx),
  }));
}

/**
 * The same series from the kubelet's cumulative counters.
 *
 * Counters cannot be added across machines: each one resets on its own
 * schedule, and a sum of two counters where one restarted is a number that
 * never happened. Each node's counter becomes a rate first, and the rates add.
 */
async function kubeletTraffic(
  db: Kysely<Database>,
  since: number,
  until: number,
  widthMs: number,
): Promise<ClusterTrafficPoint[]> {
  const bucket = bucketOf(widthMs);

  const rows = await db
    .selectFrom('node_samples')
    .select([
      bucket.as('bucket'),
      'node',
      sql<number>`max(at)`.as('at'),
      sql<number | null>`max(net_rx)`.as('rx'),
      sql<number | null>`max(net_tx)`.as('tx'),
    ])
    .where('at', '>=', since)
    .where('at', '<=', until)
    .groupBy([bucket, 'node'])
    .orderBy(bucket, 'asc')
    .execute();

  const previous = new Map<string, { at: number; rx: number; tx: number }>();
  const points = new Map<number, ClusterTrafficPoint>();

  for (const row of rows) {
    const at = Number(row.at);
    const bucketKey = Number(row.bucket);
    const rx = nullableNumber(row.rx);
    const tx = nullableNumber(row.tx);

    const last = previous.get(row.node);
    const rxRate =
      rx === null ? null : counterRate(last && { at: last.at, value: last.rx }, { at, value: rx });
    const txRate =
      tx === null ? null : counterRate(last && { at: last.at, value: last.tx }, { at, value: tx });

    if (rx !== null && tx !== null) previous.set(row.node, { at, rx, tx });

    const point = points.get(bucketKey) ?? { at, rxBytesPerSecond: null, txBytesPerSecond: null };
    points.set(bucketKey, {
      at: Math.max(point.at, at),
      rxBytesPerSecond: add(point.rxBytesPerSecond, rxRate),
      txBytesPerSecond: add(point.txBytesPerSecond, txRate),
    });
  }

  return [...points.entries()].sort(([a], [b]) => a - b).map(([, point]) => point);
}

/** A sum that stays null until something has answered. */
function add(total: number | null, value: number | null): number | null {
  if (value === null) return total;
  return (total ?? 0) + value;
}

function nullableNumber(value: number | string | null): number | null {
  return value === null ? null : Number(value);
}
