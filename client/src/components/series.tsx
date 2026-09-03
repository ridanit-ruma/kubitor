'use client';

import { useId, useState } from 'react';
import { formatTimestamp } from '@/lib/format';

export interface SeriesValue {
  at: number;
  value: number | null;
}

/**
 * A time series drawn as inline SVG.
 *
 * Charting libraries are heavy for one shape, and this one has to do something
 * a generic chart does badly: a gap in the data must read as a gap. A missing
 * sample — an unreachable kubelet, a counter reset — breaks the line rather than
 * being interpolated across, because a smooth line through a hole is a lie about
 * what was measured.
 */
export function Series({
  title,
  points,
  format,
  height = 120,
}: {
  title: string;
  points: readonly SeriesValue[];
  format(value: number | null): string;
  height?: number;
}) {
  const gradientId = useId();
  const [hover, setHover] = useState<SeriesValue | null>(null);

  const usable = points.filter((point) => point.value !== null);
  const latest = points.at(-1) ?? null;

  if (usable.length < 2) {
    return (
      <figure className="rounded-lg border border-line bg-card p-4">
        <Header title={title} reading={format(latest?.value ?? null)} />
        <p className="mt-6 text-center text-sm text-muted-foreground">Not enough readings yet.</p>
      </figure>
    );
  }

  const width = 600;
  const minAt = points[0]?.at ?? 0;
  const maxAt = points.at(-1)?.at ?? minAt + 1;
  const span = Math.max(1, maxAt - minAt);

  const values = usable.map((point) => point.value as number);
  const maxValue = Math.max(...values);
  const ceiling = maxValue === 0 ? 1 : maxValue * 1.1;

  const x = (at: number): number => ((at - minAt) / span) * width;
  const y = (value: number): number => height - (value / ceiling) * height;

  // Each run of consecutive readings is its own path, so gaps stay gaps.
  const segments: string[] = [];
  let current: string[] = [];
  for (const point of points) {
    if (point.value === null) {
      if (current.length > 1) segments.push(current.join(' '));
      current = [];
      continue;
    }
    current.push(`${current.length === 0 ? 'M' : 'L'}${x(point.at)},${y(point.value)}`);
  }
  if (current.length > 1) segments.push(current.join(' '));

  return (
    <figure className="rounded-lg border border-line bg-card p-4">
      <Header
        title={title}
        reading={format(hover ? hover.value : (latest?.value ?? null))}
        when={hover ? formatTimestamp(hover.at) : undefined}
      />

      <svg
        role="img"
        aria-label={`${title} over time`}
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        className="mt-3 h-[120px] w-full"
        onMouseLeave={() => setHover(null)}
        onMouseMove={(event) => {
          const box = event.currentTarget.getBoundingClientRect();
          const ratio = (event.clientX - box.left) / box.width;
          const at = minAt + ratio * span;
          const nearest = points.reduce((best, point) =>
            Math.abs(point.at - at) < Math.abs(best.at - at) ? point : best,
          );
          setHover(nearest);
        }}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--signal)" stopOpacity="0.28" />
            <stop offset="100%" stopColor="var(--signal)" stopOpacity="0" />
          </linearGradient>
        </defs>

        {segments.map((segment) => (
          <path
            key={segment.slice(0, 24)}
            d={`${segment} L${width},${height} L0,${height} Z`}
            fill={`url(#${gradientId})`}
            stroke="none"
          />
        ))}

        {segments.map((segment) => (
          <path
            key={`line-${segment.slice(0, 24)}`}
            d={segment}
            fill="none"
            stroke="var(--signal)"
            strokeWidth={1.5}
            vectorEffect="non-scaling-stroke"
          />
        ))}

        {hover?.value !== null && hover !== null && (
          <line
            x1={x(hover.at)}
            x2={x(hover.at)}
            y1={0}
            y2={height}
            stroke="var(--muted-ink)"
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
          />
        )}
      </svg>
    </figure>
  );
}

function Header({
  title,
  reading,
  when,
}: {
  title: string;
  reading: string;
  when?: string | undefined;
}) {
  return (
    <figcaption className="flex items-baseline justify-between gap-3">
      <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
        {title}
      </span>
      <span className="font-mono text-sm tabular">
        {reading}
        {when && <span className="ml-2 text-xs text-muted-foreground">{when}</span>}
      </span>
    </figcaption>
  );
}
