import { describe, expect, it } from 'vitest';
import { BackupScheduler } from './scheduler.js';

function at(iso: string): Date {
  return new Date(iso);
}

function schedulerAt(times: string[], schedule = '17 3 * * *') {
  let index = 0;
  const runs: string[] = [];

  const scheduler = new BackupScheduler({
    schedule,
    now: () => at(times[Math.min(index, times.length - 1)] as string),
    run: async () => {
      runs.push(times[Math.min(index, times.length - 1)] as string);
    },
  });

  return {
    scheduler,
    runs,
    async advance() {
      await scheduler.tick();
      index += 1;
    },
  };
}

describe('BackupScheduler', () => {
  it('fires on the minute its expression names, and not before', async () => {
    const harness = schedulerAt(['2026-09-06T03:16:00', '2026-09-06T03:17:00']);

    await harness.advance();
    expect(harness.runs).toEqual([]);

    await harness.advance();
    expect(harness.runs).toEqual(['2026-09-06T03:17:00']);
  });

  /** A tick that arrives twice inside one minute must not run two backups. */
  it('fires once per minute however often it is ticked', async () => {
    const harness = schedulerAt(['2026-09-06T03:17:00', '2026-09-06T03:17:00']);

    await harness.advance();
    await harness.advance();

    expect(harness.runs).toHaveLength(1);
  });

  /**
   * A backup that throws must not take the timer with it. Losing the interval
   * would end every future backup silently, which is the exact failure the
   * whole feature exists to prevent.
   */
  it('survives a backup that throws', async () => {
    const errors: unknown[] = [];
    const scheduler = new BackupScheduler({
      schedule: '* * * * *',
      now: () => at('2026-09-06T03:17:00'),
      run: async () => {
        throw new Error('bucket unreachable');
      },
      onError: (error) => errors.push(error),
    });

    await expect(scheduler.tick()).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
  });

  it('says when the next one is due', () => {
    const scheduler = new BackupScheduler({
      schedule: '17 3 * * *',
      now: () => at('2026-09-06T10:00:00'),
      run: async () => undefined,
    });

    expect(scheduler.next()?.toISOString()).toBe(at('2026-09-07T03:17:00').toISOString());
  });

  it('refuses an expression it cannot parse, at construction', () => {
    expect(
      () =>
        new BackupScheduler({
          schedule: 'nightly please',
          now: () => at('2026-09-06T03:17:00'),
          run: async () => undefined,
        }),
    ).toThrow();
  });
});
