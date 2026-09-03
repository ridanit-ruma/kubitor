export interface SensorGroup {
  chip: string;
  /** The one reading that speaks for the chip, where there is one. */
  headline: { label: string; celsius: number } | null;
  /** Everything else, summarized rather than listed. */
  lowest: number;
  highest: number;
  count: number;
}

/**
 * Sensor readings, grouped by the chip that produced them.
 *
 * A modern CPU reports a package temperature and one per core, and an NVMe
 * reports three. Listed flat that is twenty near-identical numbers, and the one
 * that matters — the hottest — is no easier to find than any other. Each chip
 * collapses to its headline reading plus the range underneath it.
 */
export function groupSensors(temps: Record<string, number>): SensorGroup[] {
  const byChip = new Map<string, { label: string; celsius: number }[]>();

  for (const [key, celsius] of Object.entries(temps)) {
    const separator = key.indexOf('.');
    const chip = separator === -1 ? key : key.slice(0, separator);
    const label = separator === -1 ? key : key.slice(separator + 1);

    byChip.set(chip, [...(byChip.get(chip) ?? []), { label, celsius }]);
  }

  return [...byChip.entries()]
    .map(([chip, readings]) => {
      const values = readings.map((reading) => reading.celsius);

      return {
        chip,
        headline: headlineOf(readings),
        lowest: Math.min(...values),
        highest: Math.max(...values),
        count: readings.length,
      };
    })
    .sort((a, b) => b.highest - a.highest);
}

/**
 * The reading a person means when they ask how hot a chip is.
 *
 * A package sensor covers the whole die and is the honest answer for a CPU; a
 * composite sensor is the drive's own summary. Where neither exists, no reading
 * speaks for the rest and the range alone is reported.
 */
function headlineOf(
  readings: readonly { label: string; celsius: number }[],
): { label: string; celsius: number } | null {
  const preferred = readings.find((reading) =>
    /^(package|composite|tctl|tdie)/i.test(reading.label),
  );
  if (preferred) return preferred;

  return readings.length === 1 ? (readings[0] ?? null) : null;
}
