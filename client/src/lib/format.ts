/**
 * Every figure on screen is a measurement, so the rules are the same
 * everywhere: binary units for bytes, rates for counters, percentages against
 * real capacity, and an honest "unknown" rather than a plausible zero.
 */

const BINARY_UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'] as const;

/** Bytes in binary units — 1 KiB is 1024 B, because that is what the kernel reports. */
export function formatBytes(bytes: number | null | undefined, digits = 1): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return '—';
  if (bytes === 0) return '0 B';

  const exponent = Math.min(Math.floor(Math.log2(Math.abs(bytes)) / 10), BINARY_UNITS.length - 1);
  const value = bytes / 1024 ** exponent;

  return `${value.toFixed(exponent === 0 ? 0 : digits)} ${BINARY_UNITS[exponent]}`;
}

export function formatBytesPerSecond(rate: number | null | undefined): string {
  if (rate === null || rate === undefined) return '—';
  return `${formatBytes(rate)}/s`;
}

/** Millicores, shown as cores once there is a whole one. */
export function formatCpu(milli: number | null | undefined): string {
  if (milli === null || milli === undefined || !Number.isFinite(milli)) return '—';
  return milli < 1000 ? `${Math.round(milli)}m` : `${(milli / 1000).toFixed(2)} cores`;
}

export function formatPercent(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `${value.toFixed(digits)}%`;
}

export function formatCelsius(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `${value.toFixed(1)}°C`;
}

/**
 * How old a reading is, in words that hold still.
 *
 * Deliberately coarse under a minute. A label that counted seconds rewrote
 * itself on every tick, and text flickering in the corner of the eye reads as
 * something being wrong rather than as something being fresh. Freshness is the
 * indicator's job; this text is for when a reading has stopped being fresh, and
 * the exact instant is always one hover away.
 */
export function formatAge(sampledAt: number | null | undefined, now: number): string {
  if (sampledAt === null || sampledAt === undefined) return 'no data';

  const seconds = Math.max(0, Math.round((now - sampledAt) / 1000));
  if (seconds < 60) return 'current';

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m old`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h old`;

  return `${Math.floor(hours / 24)}d old`;
}

/** A wall-clock timestamp, in the viewer's own zone. */
export function formatTimestamp(at: number | null | undefined): string {
  if (at === null || at === undefined) return '—';
  return new Date(at).toLocaleString(undefined, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

export function formatCount(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return value.toLocaleString();
}

/** Duration in milliseconds, kept legible at both ends of the range. */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

/** Clock speed, shown in gigahertz once it is past a gigahertz. */
export function formatMhz(mhz: number | null | undefined): string {
  if (mhz === null || mhz === undefined || !Number.isFinite(mhz)) return '—';
  return mhz >= 1000 ? `${(mhz / 1000).toFixed(2)} GHz` : `${Math.round(mhz)} MHz`;
}

/**
 * A quantity against its total, in one string.
 *
 * The whole point is that neither half travels alone: "5.4 GiB" says nothing
 * about pressure, and "23%" says nothing about size. Screens that show one
 * without the other are how a memory figure gets mistaken for a disk figure.
 */
export function formatOfTotal(
  used: number | null | undefined,
  total: number | null | undefined,
): string {
  if (used === null || used === undefined) return '—';
  if (total === null || total === undefined) return formatBytes(used);
  return `${formatBytes(used)} / ${formatBytes(total)}`;
}

/**
 * A time-axis label, scaled to the window it sits in.
 *
 * A five-minute chart needs seconds to distinguish its ticks; a seven-day chart
 * needs the date and nothing finer. Printing the same precision at both ends
 * makes one axis unreadable and the other repetitive.
 */
export function formatAxisTime(at: number, spanMs: number): string {
  const when = new Date(at);

  if (spanMs <= 15 * 60_000) {
    return when.toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
  }

  if (spanMs <= 36 * 3_600_000) {
    return when.toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  }

  return when.toLocaleDateString(undefined, { month: '2-digit', day: '2-digit' });
}

/**
 * A chart's top gridline, at a number worth printing.
 *
 * A ceiling of "the peak plus ten percent" puts labels like 1.37 GiB on the
 * axis — a number nobody is looking for. Rounding up to 1, 2, 2.5 or 5 times a
 * power of ten gives an axis whose labels are landmarks.
 */
export function niceCeiling(peak: number): number {
  if (!Number.isFinite(peak) || peak <= 0) return 1;

  const magnitude = 10 ** Math.floor(Math.log10(peak));
  for (const step of [1, 2, 2.5, 5, 10]) {
    const candidate = step * magnitude;
    if (candidate >= peak) return candidate;
  }
  return 10 * magnitude;
}
