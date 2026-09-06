import { describe, expect, it } from 'vitest';
import { matches, nextAfter, parseCron } from './cron.js';

const at = (iso: string) => new Date(iso);

describe('parseCron', () => {
  it('takes the default schedule', () => {
    const expression = parseCron('17 3 * * *');

    expect([...expression.minute]).toEqual([17]);
    expect([...expression.hour]).toEqual([3]);
    expect(expression.dayOfMonth.size).toBe(31);
  });

  it('takes lists, ranges and steps', () => {
    expect([...parseCron('0,30 * * * *').minute]).toEqual([0, 30]);
    expect([...parseCron('0 9-11 * * *').hour]).toEqual([9, 10, 11]);
    expect([...parseCron('*/15 * * * *').minute]).toEqual([0, 15, 30, 45]);
  });

  it('refuses an expression that is not five fields', () => {
    expect(() => parseCron('17 3 * *')).toThrow(/five fields/);
  });

  it('refuses a value outside its field', () => {
    expect(() => parseCron('60 3 * * *')).toThrow();
    expect(() => parseCron('0 24 * * *')).toThrow();
  });
});

describe('matches', () => {
  it('matches only the minute it names', () => {
    const expression = parseCron('17 3 * * *');

    expect(matches(expression, at('2026-09-06T03:17:00'))).toBe(true);
    expect(matches(expression, at('2026-09-06T03:18:00'))).toBe(false);
    expect(matches(expression, at('2026-09-06T04:17:00'))).toBe(false);
  });

  /**
   * Real cron ORs day-of-month against day-of-week when both are restricted,
   * which surprises everyone who expects AND. Copying the surprise is better
   * than inventing a second dialect.
   */
  it('ors the two day fields, the way cron does', () => {
    const expression = parseCron('0 0 1 * 0');

    expect(matches(expression, at('2026-09-01T00:00:00'))).toBe(true);
    expect(matches(expression, at('2026-09-06T00:00:00'))).toBe(true);
    expect(matches(expression, at('2026-09-07T00:00:00'))).toBe(false);
  });
});

describe('nextAfter', () => {
  it('finds the next occurrence', () => {
    const next = nextAfter(parseCron('17 3 * * *'), at('2026-09-06T03:17:30'));
    expect(next?.toISOString()).toBe(new Date('2026-09-07T03:17:00').toISOString());
  });

  it('never returns the minute it was given', () => {
    const from = at('2026-09-06T03:17:00');
    expect(nextAfter(parseCron('* * * * *'), from)?.getTime()).toBeGreaterThan(from.getTime());
  });

  it('reaches a date only a leap year has', () => {
    expect(nextAfter(parseCron('0 0 29 2 *'), at('2026-03-01T00:00:00'))).not.toBeNull();
  });
});
