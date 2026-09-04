import { describe, expect, it } from 'vitest';
import { bucketWidthFor, MAX_SERIES_POINTS, STORE_INTERVAL_MS } from './query.controller.js';

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

describe('bucketWidthFor', () => {
  /** Short windows hold few enough readings to draw every one of them. */
  it('does not bucket a window the stored samples already fit', () => {
    expect(bucketWidthFor(5 * MINUTE_MS)).toBe(0);
    expect(bucketWidthFor(HOUR_MS)).toBe(0);
    expect(bucketWidthFor(MAX_SERIES_POINTS * STORE_INTERVAL_MS)).toBe(0);
  });

  /**
   * Seven days is forty thousand samples. Drawn raw they are noise, and a row
   * limit would keep the oldest of them — a chart that stops days before now
   * while still claiming to cover the week.
   */
  it('reduces a long window to a drawable number of points', () => {
    for (const span of [12 * HOUR_MS, DAY_MS, 2 * DAY_MS, 7 * DAY_MS]) {
      const width = bucketWidthFor(span);
      expect(width).toBeGreaterThan(0);
      expect(span / width).toBeLessThanOrEqual(MAX_SERIES_POINTS);
    }
  });

  /** Whole storage intervals, so no bucket averages one reading fewer than its neighbour. */
  it('buckets in whole storage intervals', () => {
    expect(bucketWidthFor(7 * DAY_MS) % STORE_INTERVAL_MS).toBe(0);
    expect(bucketWidthFor(DAY_MS) % STORE_INTERVAL_MS).toBe(0);
  });
});
