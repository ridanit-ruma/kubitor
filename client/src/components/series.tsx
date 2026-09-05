'use client';

import { useId, useState } from 'react';
import { formatAxisTime, formatPointTime, niceCeiling } from '@/lib/format';

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
 *
 * The axes are HTML rather than SVG text. The plot stretches to whatever width
 * it is given, and text inside a stretched viewBox stretches with it.
 */
export function Series({
  title,
  points,
  format,
  ceiling: fixedCeiling,
  height = 120,
}: {
  title: string;
  points: readonly SeriesValue[];
  format(value: number | null): string;
  /**
   * The top of the scale, where the measurement has a real one.
   *
   * A chart scaled to its own peak makes a machine at 3% look identical to one
   * at 90%: both fill the box. Utilisation runs to 100 and memory runs to the
   * RAM that is installed, and drawing them against that is what makes two
   * nodes comparable at a glance. Left out, the scale follows the data.
   */
  ceiling?: number | null;
  height?: number;
}) {
  const gradientId = useId();
  /**
   * What the cursor is over, and where the cursor is.
   *
   * The reading is the nearest sample; the position is the pointer's own, as a
   * share of the plot, so the label can follow the hand rather than jumping
   * between sample columns.
   */
  const [hover, setHover] = useState<{ point: SeriesValue; x: number; y: number } | null>(null);

  const usable = points.filter((point) => point.value !== null);
  const latest = points.at(-1) ?? null;

  if (usable.length < 2) {
    return (
      <figure className="rounded-lg border border-line bg-card p-3">
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
  const ceiling =
    fixedCeiling !== null && fixedCeiling !== undefined && fixedCeiling > 0
      ? fixedCeiling
      : niceCeiling(Math.max(...values));

  const x = (at: number): number => ((at - minAt) / span) * width;
  const y = (value: number): number =>
    height - (Math.min(Math.max(value, 0), ceiling) / ceiling) * height;

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
    <figure className="rounded-lg border border-line bg-card p-3">
      {/*
        The heading keeps saying what the reading is now. It used to be
        rewritten to whatever the cursor was over, so moving the mouse changed
        the number a reader had come to the screen to watch — and the moment
        they looked away from the cursor they had no idea which of the two they
        were looking at.
      */}
      <Header title={title} reading={format(latest?.value ?? null)} />

      <div className="mt-3 flex gap-2">
        <div
          className="flex w-20 shrink-0 flex-col justify-between text-right font-mono text-[10px] text-muted-foreground"
          style={{ height }}
        >
          <span>{format(ceiling)}</span>
          <span>{format(ceiling / 2)}</span>
          <span>{format(0)}</span>
        </div>

        {/* The anchor the floating label is positioned against. */}
        <div className="relative min-w-0 flex-1">
          <svg
            role="img"
            aria-label={`${title} over time`}
            viewBox={`0 0 ${width} ${height}`}
            preserveAspectRatio="none"
            className="w-full"
            style={{ height }}
            onMouseLeave={() => setHover(null)}
            onMouseMove={(event) => {
              const box = event.currentTarget.getBoundingClientRect();
              const x = (event.clientX - box.left) / box.width;
              const y = (event.clientY - box.top) / box.height;
              const at = minAt + x * span;
              const nearest = points.reduce((best, point) =>
                Math.abs(point.at - at) < Math.abs(best.at - at) ? point : best,
              );
              setHover({ point: nearest, x, y });
            }}
          >
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--signal)" stopOpacity="0.28" />
                <stop offset="100%" stopColor="var(--signal)" stopOpacity="0" />
              </linearGradient>
            </defs>

            {/* One line per y label, so a value can be read off the chart. */}
            {[0, height / 2, height].map((at) => (
              <line
                key={at}
                x1={0}
                x2={width}
                y1={at}
                y2={at}
                stroke="var(--line)"
                strokeWidth={1}
                vectorEffect="non-scaling-stroke"
              />
            ))}

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

            {hover && (
              <line
                x1={x(hover.point.at)}
                x2={x(hover.point.at)}
                y1={0}
                y2={height}
                stroke="var(--muted-ink)"
                strokeWidth={1}
                vectorEffect="non-scaling-stroke"
              />
            )}
            {hover?.point.value != null && (
              <circle cx={x(hover.point.at)} cy={y(hover.point.value)} r={3} fill="var(--signal)" />
            )}
          </svg>

          {hover && (
            /*
             * Follows the pointer, and flips to its other side past the middle so
             * the label never runs off the edge of a card — this chart is often a
             * third of the width of a screen.
             */
            <div
              aria-hidden
              className="pointer-events-none absolute z-10 whitespace-nowrap rounded border border-line bg-popover px-1.5 py-1 font-mono text-[11px] tabular shadow-sm"
              style={{
                left: `${hover.x * 100}%`,
                top: `${hover.y * 100}%`,
                transform: `translate(${hover.x > 0.5 ? 'calc(-100% - 12px)' : '12px'}, -50%)`,
              }}
            >
              {format(hover.point.value)}
              <span className="ml-2 text-muted-foreground">
                {formatPointTime(hover.point.at, span)}
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Aligned with the plot, which starts after the label column and its gap. */}
      <div className="ml-22 mt-1.5 flex justify-between font-mono text-[10px] text-muted-foreground">
        <span>{formatAxisTime(minAt, span)}</span>
        <span>{formatAxisTime(minAt + span / 2, span)}</span>
        <span>{formatAxisTime(maxAt, span)}</span>
      </div>
    </figure>
  );
}

function Header({ title, reading }: { title: string; reading: string }) {
  return (
    <figcaption className="flex items-baseline justify-between gap-3">
      <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
        {title}
      </span>
      <span className="font-mono text-sm tabular">{reading}</span>
    </figcaption>
  );
}
