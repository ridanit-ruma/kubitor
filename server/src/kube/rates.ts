export interface CounterReading {
  at: number;
  value: number;
}

/**
 * Converts a cumulative counter into a per-second rate.
 *
 * Counters reset when an interface or a container restarts. A naive delta then
 * produces a large negative number, which plotted as a rate looks like traffic
 * flowing backwards. The reset is dropped instead: one missing point is honest,
 * a wrong point is not.
 *
 * Returns null when no rate can be computed, so callers must decide what to
 * show rather than silently receiving a zero.
 */
export function counterRate(
  previous: CounterReading | undefined,
  current: CounterReading,
): number | null {
  if (!previous) return null;

  const elapsedMs = current.at - previous.at;
  if (elapsedMs <= 0) return null;

  const delta = current.value - previous.value;
  if (delta < 0) return null;

  return (delta * 1000) / elapsedMs;
}

/** Percentage of a capacity, clamped and null-safe rather than NaN. */
export function percentOf(used: number | null, capacity: number | null): number | null {
  if (used === null || capacity === null || capacity <= 0) return null;
  return Math.min(100, Math.max(0, (used / capacity) * 100));
}
