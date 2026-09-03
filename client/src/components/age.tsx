'use client';

import { formatAge } from '@/lib/format';
import { cn } from '@/lib/utils';

/**
 * How old the number beside it actually is.
 *
 * kubitor pushes once a second but samples every fifteen, so a value can move
 * smoothly while being a quarter-minute old. The dot goes amber once a reading
 * is older than the interface implies, which is the difference between a live
 * display and a merely convincing one.
 */
export function Age({
  sampledAt,
  now,
  staleAfterMs = 30_000,
  className,
}: {
  sampledAt: number | null | undefined;
  now: number;
  staleAfterMs?: number;
  className?: string;
}) {
  const missing = sampledAt === null || sampledAt === undefined;
  const stale = !missing && now - sampledAt > staleAfterMs;

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 font-mono text-xs',
        missing || stale ? 'text-blind' : 'text-muted-foreground',
        className,
      )}
      title={missing ? 'No reading yet' : new Date(sampledAt).toLocaleString()}
    >
      <span
        aria-hidden
        className={cn(
          'size-1.5 rounded-full',
          missing ? 'bg-blind' : stale ? 'bg-blind' : 'bg-signal',
        )}
      />
      {formatAge(sampledAt, now)}
    </span>
  );
}
