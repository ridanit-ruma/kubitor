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
 * How old a reading is, in words.
 *
 * This is the counterweight to a one-second refresh: the dashboard moves every
 * second, but the number underneath may be fifteen seconds old, and saying so is
 * the difference between a live display and a convincing one.
 */
export function formatAge(sampledAt: number | null | undefined, now: number): string {
  if (sampledAt === null || sampledAt === undefined) return 'no data';

  const seconds = Math.max(0, Math.round((now - sampledAt) / 1000));
  if (seconds < 1) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;

  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  return `${Math.round(hours / 24)}d ago`;
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
