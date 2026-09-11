/**
 * Just enough cron to say "every night at 03:17".
 *
 * Five standard fields, `*`, `n`, `a,b`, `a-b` and `*\/n`. Not a dependency:
 * a backup schedule is one expression an operator writes once, and the parsing
 * of it is sixty lines that can be tested exhaustively.
 */
export interface CronExpression {
  minute: Set<number>;
  hour: Set<number>;
  dayOfMonth: Set<number>;
  month: Set<number>;
  dayOfWeek: Set<number>;
}

const RANGES = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 6],
] as const;

export function parseCron(expression: string): CronExpression {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`cron needs five fields, got ${fields.length}: ${expression}`);
  }

  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields.map((field, index) => {
    const [low, high] = RANGES[index] as readonly [number, number];
    return parseField(field, low, high, expression);
  }) as [Set<number>, Set<number>, Set<number>, Set<number>, Set<number>];

  return { minute, hour, dayOfMonth, month, dayOfWeek };
}

function parseField(field: string, low: number, high: number, whole: string): Set<number> {
  const values = new Set<number>();

  for (const part of field.split(',')) {
    const [range, step = '1'] = part.split('/');
    const stride = Number(step);
    if (!Number.isInteger(stride) || stride < 1) throw new Error(`bad step in ${whole}`);

    let from = low;
    let to = high;
    if (range !== '*' && range !== undefined) {
      const [start, end] = range.split('-');
      from = Number(start);
      to = end === undefined ? (step === '1' ? from : high) : Number(end);
    }

    if (!Number.isInteger(from) || !Number.isInteger(to) || from < low || to > high || from > to) {
      throw new Error(`bad field "${part}" in ${whole}`);
    }
    for (let value = from; value <= to; value += stride) values.add(value);
  }

  return values;
}

/**
 * Whether a minute is one the expression names.
 *
 * Day-of-month and day-of-week are OR'd when both are restricted, which is what
 * cron does and what surprises people who expect AND.
 */
export function matches(expression: CronExpression, at: Date): boolean {
  const dayRestricted = expression.dayOfMonth.size < 31;
  const weekRestricted = expression.dayOfWeek.size < 7;

  const day =
    dayRestricted && weekRestricted
      ? expression.dayOfMonth.has(at.getDate()) || expression.dayOfWeek.has(at.getDay())
      : expression.dayOfMonth.has(at.getDate()) && expression.dayOfWeek.has(at.getDay());

  return (
    expression.minute.has(at.getMinutes()) &&
    expression.hour.has(at.getHours()) &&
    expression.month.has(at.getMonth() + 1) &&
    day
  );
}

/** The next minute the expression names, so a screen can say when. */
export function nextAfter(expression: CronExpression, from: Date): Date | null {
  const at = new Date(from.getTime());
  at.setSeconds(0, 0);
  at.setMinutes(at.getMinutes() + 1);

  // Four years covers every February 29th an expression can name.
  for (let step = 0; step < 4 * 366 * 24 * 60; step += 1) {
    if (matches(expression, at)) return at;
    at.setMinutes(at.getMinutes() + 1);
  }
  return null;
}

/**
 * Whether an expression parses at all, where the reason it did not is nobody's
 * business but the caller's.
 *
 * Both boundaries that take a schedule use this — the environment as it loads,
 * and the stored document as it is read — so an expression that cannot be run
 * is refused at the door rather than thrown from the scheduler's constructor,
 * where it takes the boot with it.
 */
export function isCronExpression(value: string): boolean {
  try {
    parseCron(value);
    return true;
  } catch {
    return false;
  }
}
