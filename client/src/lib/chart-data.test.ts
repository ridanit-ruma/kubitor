import { expect, it } from 'vitest';
import { withLiveTail } from './chart-data';
import type { LiveSample } from './live';

const HOUR_MS = 3_600_000;

function sample(at: number, cpuPercent: number): LiveSample {
  return {
    source: 'host',
    at,
    cpuPercent,
    memoryBytes: null,
    netRxBytesPerSecond: null,
    netTxBytesPerSecond: null,
  };
}

const history = [
  { at: 1000, value: 1 },
  { at: 16_000, value: 2 },
];

it('keeps history untouched when nothing newer has arrived', () => {
  const tail = [sample(500, 9), sample(16_000, 9)];
  expect(withLiveTail(history, tail, HOUR_MS, (s) => s.cpuPercent)).toEqual(history);
});

it('appends only the readings that postdate the stored history', () => {
  const tail = [sample(1000, 9), sample(20_000, 7)];
  const merged = withLiveTail(history, tail, HOUR_MS, (s) => s.cpuPercent);

  expect(merged).toHaveLength(3);
  expect(merged.at(-1)).toEqual({ at: 20_000, value: 7 });
});

it('thins the tail to the resolution the chart can draw', () => {
  // Ten minutes of per-second readings against a seven-day window, where one
  // drawable step is a little over half an hour.
  const tail = Array.from({ length: 600 }, (_, index) => sample(20_000 + index * 1000, index));
  const merged = withLiveTail(history, tail, 7 * 24 * HOUR_MS, (s) => s.cpuPercent);

  // The first tail reading, then nothing else fits before the newest one.
  expect(merged).toHaveLength(history.length + 2);
  expect(merged.at(-1)?.at).toBe(20_000 + 599 * 1000);
});

it('keeps every reading when the window is short enough to show them', () => {
  const tail = Array.from({ length: 60 }, (_, index) => sample(20_000 + index * 1000, index));
  const merged = withLiveTail(history, tail, 5 * 60_000, (s) => s.cpuPercent);

  expect(merged).toHaveLength(history.length + 60);
});

it('carries the picked value through, nulls included', () => {
  const tail = [{ ...sample(30_000, 0), cpuPercent: null }];
  const merged = withLiveTail(history, tail, HOUR_MS, (s) => s.cpuPercent);
  expect(merged.at(-1)).toEqual({ at: 30_000, value: null });
});
