import { cn } from '@/lib/utils';

/**
 * One resource, with its total always beside it.
 *
 * A used figure on its own is unreadable — 2.1 GiB is either most of a small
 * machine or nothing on a large one — and a bare percentage hides the size
 * entirely. Both halves are shown together, in the same unit, which is what
 * keeps a memory reading from being mistaken for a disk reading.
 */
export function ResourceCard({
  label,
  headline,
  percent,
  detail,
  aside,
  tone = 'signal',
  className,
}: {
  label: string;
  /** Typically `used / total`, or a percentage where that is the natural unit. */
  headline: string;
  percent?: number | null;
  detail?: string;
  /** A second line for whatever this resource specifically needs to say. */
  aside?: React.ReactNode;
  tone?: 'signal' | 'blind';
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col rounded-lg border border-line bg-card px-4 py-3', className)}>
      <div className="flex items-baseline justify-between gap-2">
        <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
          {label}
        </p>
        {percent !== undefined && (
          <p
            className={cn(
              'font-mono text-xs tabular',
              percent === null ? 'text-blind' : 'text-muted-foreground',
            )}
          >
            {percent === null ? 'unknown' : `${percent.toFixed(percent < 10 ? 1 : 0)}%`}
          </p>
        )}
      </div>

      <p className="mt-1 font-mono text-xl font-medium tabular">{headline}</p>

      {percent !== undefined && <Bar percent={percent} tone={tone} />}

      {detail && <p className="mt-2 text-xs text-muted-foreground">{detail}</p>}
      {aside}
    </div>
  );
}

/** A proportion, drawn. Absent data leaves the track empty rather than at zero. */
export function Bar({
  percent,
  tone = 'signal',
  className,
}: {
  percent: number | null;
  tone?: 'signal' | 'blind';
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn('mt-2 block h-1 overflow-hidden rounded-full bg-muted', className)}
    >
      {percent !== null && (
        <span
          className={cn('block h-full rounded-full', tone === 'blind' ? 'bg-blind' : 'bg-signal')}
          style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
        />
      )}
    </span>
  );
}
