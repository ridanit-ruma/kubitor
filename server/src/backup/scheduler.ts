import { type CronExpression, matches, nextAfter, parseCron } from './cron.js';

/** Checked once a minute, which is the finest a cron expression can name. */
const TICK_MS = 60_000;

export interface BackupSchedulerDeps {
  schedule: string;
  run(): Promise<unknown>;
  now(): Date;
  onError?(error: unknown): void;
}

/**
 * Runs a backup on the minutes its expression names.
 *
 * Deliberately not a general job runner. It ticks once a minute, remembers the
 * minute it last fired so a tick that arrives twice inside one minute cannot
 * run two backups, and never lets a failure escape into the timer — a backup
 * that throws must not take the interval down with it and silently end every
 * future backup.
 */
export class BackupScheduler {
  readonly #deps: BackupSchedulerDeps;
  #expression: CronExpression;
  #timer: ReturnType<typeof setInterval> | null = null;
  #lastFiredMinute: number | null = null;
  #running = false;

  constructor(deps: BackupSchedulerDeps) {
    this.#deps = deps;
    this.#expression = parseCron(deps.schedule);
  }

  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => void this.tick(), TICK_MS);
    // Nothing here should hold the process open at shutdown.
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  /**
   * Points the scheduler at a different expression.
   *
   * The last-fired minute is cleared with it. That guard exists so one minute
   * cannot fire twice; after a change, a match on the new expression is a
   * different backup rather than a repeat of the old one.
   */
  setSchedule(expression: string): void {
    this.#expression = parseCron(expression);
    this.#lastFiredMinute = null;
  }

  /** The next minute this will fire, for the screen to show. */
  next(from = this.#deps.now()): Date | null {
    return nextAfter(this.#expression, from);
  }

  /** Exposed so a test does not have to wait a minute to see it work. */
  async tick(): Promise<void> {
    const at = this.#deps.now();
    if (!matches(this.#expression, at)) return;

    const minute = Math.floor(at.getTime() / TICK_MS);
    if (minute === this.#lastFiredMinute) return;

    // A backup that outran its schedule must not be started again on top of
    // itself: two VACUUMs and two uploads help nobody.
    if (this.#running) return;

    this.#lastFiredMinute = minute;
    this.#running = true;
    try {
      await this.#deps.run();
    } catch (error) {
      this.#deps.onError?.(error);
    } finally {
      this.#running = false;
    }
  }
}
