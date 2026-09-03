import { cn } from '@/lib/utils';

/**
 * One measurement, stated plainly.
 *
 * The label sits above the figure rather than below it: reading order should be
 * "what this is, then what it says", which is how someone scanning for a problem
 * actually works.
 */
export function StatTile({
  label,
  value,
  detail,
  tone = 'normal',
}: {
  label: string;
  value: string;
  detail?: string;
  tone?: 'normal' | 'blind' | 'bad' | 'good';
}) {
  const toneClass = {
    normal: 'text-foreground',
    blind: 'text-blind',
    bad: 'text-bad',
    good: 'text-good',
  }[tone];

  return (
    <div className="rounded-lg border border-line bg-card px-4 py-3">
      <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
        {label}
      </p>
      <p className={cn('mt-1 font-mono text-2xl font-medium tabular', toneClass)}>{value}</p>
      {detail && <p className="mt-0.5 text-xs text-muted-foreground">{detail}</p>}
    </div>
  );
}
