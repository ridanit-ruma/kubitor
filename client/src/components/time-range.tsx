'use client';

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

/**
 * How far back a chart looks.
 *
 * The short ranges exist because most questions about a cluster are about the
 * last few minutes; the long ones stop at seven days because that is how long
 * samples are kept, and offering a range the data cannot fill would draw an
 * authoritative chart of mostly absence.
 */
export const RANGES = [
  { minutes: 5, label: '5 minutes' },
  { minutes: 15, label: '15 minutes' },
  { minutes: 30, label: '30 minutes' },
  { minutes: 60, label: '1 hour' },
  { minutes: 180, label: '3 hours' },
  { minutes: 360, label: '6 hours' },
  { minutes: 720, label: '12 hours' },
  { minutes: 1440, label: '24 hours' },
  { minutes: 2880, label: '2 days' },
  { minutes: 10_080, label: '7 days' },
] as const;

export const DEFAULT_RANGE_MINUTES = 60;

export function TimeRange({
  minutes,
  onChange,
}: {
  minutes: number;
  onChange(minutes: number): void;
}) {
  return (
    <Select value={String(minutes)} onValueChange={(value) => onChange(Number(value))}>
      <SelectTrigger className="h-8 w-36" size="sm" aria-label="Time range">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {RANGES.map((range) => (
          <SelectItem key={range.minutes} value={String(range.minutes)}>
            {range.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
