import type { LiveSample } from './live';

export interface ChartPoint {
  at: number;
  value: number | null;
}

/**
 * How finely a chart is worth sampling: one point per two pixels of plot.
 *
 * The plot is six hundred units wide, so anything closer than this lands on a
 * pixel that is already inked.
 */
const PLOT_STEPS = 300;

/**
 * Stored history, continued with what the socket has delivered since.
 *
 * The database keeps a reading every fifteen seconds and the page refetches it
 * every thirty, so a chart drawn from history alone stands still for half a
 * minute while the figures above it move every second. The tail closes that
 * gap, and is thinned to the resolution the chart can actually draw: a
 * seven-day line gains nothing from twenty minutes of per-second samples piled
 * into its last pixel. Its newest reading is always kept, because that point is
 * the one that makes the line move.
 */
export function withLiveTail(
  history: readonly ChartPoint[],
  tail: readonly LiveSample[],
  spanMs: number,
  pick: (sample: LiveSample) => number | null,
): ChartPoint[] {
  const from = history.at(-1)?.at ?? 0;
  const fresh = tail.filter((sample) => sample.at > from);
  if (fresh.length === 0) return [...history];

  const everyMs = spanMs / PLOT_STEPS;
  const kept: LiveSample[] = [];
  for (const sample of fresh) {
    const last = kept.at(-1);
    if (!last || sample.at - last.at >= everyMs) kept.push(sample);
  }

  const newest = fresh.at(-1);
  if (newest && kept.at(-1) !== newest) kept.push(newest);

  return [...history, ...kept.map((sample) => ({ at: sample.at, value: pick(sample) }))];
}
