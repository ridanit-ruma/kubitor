import { formatCelsius } from '@/lib/format';
import { groupSensors } from '@/lib/sensors';

/**
 * Sensor readings, one line per chip.
 *
 * The grouping is the point: a CPU reports one figure per core and an NVMe
 * reports three, and listed flat that is twenty near-identical numbers with the
 * one that matters hidden among them.
 */
export function Temperatures({ temps }: { temps: Record<string, number> }) {
  const groups = groupSensors(temps);
  if (groups.length === 0) return null;

  return (
    <dl className="flex flex-col gap-2">
      {groups.map((group) => (
        <div key={group.chip} className="flex items-baseline justify-between gap-4">
          <dt className="font-mono text-xs text-muted-foreground">{group.chip}</dt>
          <dd className="flex items-baseline gap-3 font-mono text-xs tabular">
            <span className="text-sm">
              {formatCelsius(group.headline?.celsius ?? group.highest)}
            </span>
            {group.count > 1 && (
              <span className="text-muted-foreground">
                {formatCelsius(group.lowest)}–{formatCelsius(group.highest)} across {group.count}
              </span>
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}
