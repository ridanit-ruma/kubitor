export interface SensorReading {
  /** Driver name: `coretemp`, `nvme`, `iwlwifi_1`. */
  chip: string;
  /** The device it belongs to, where the kernel could name one: `nvme0`. */
  device: string | null;
  label: string;
  celsius: number;
}

export interface SensorSummary {
  /** The reading that speaks for the group. */
  celsius: number;
  lowest: number;
  highest: number;
  count: number;
}

/** Chips that measure the processor, whichever vendor made it. */
const CPU_CHIPS = ['coretemp', 'k10temp', 'zenpower', 'cpu_thermal', 'cpu-thermal', 'acpitz'];

/**
 * One figure for a set of readings, plus the range behind it.
 *
 * A CPU reports a package temperature and one per core, and an NVMe reports
 * three. The package or composite sensor covers the whole part and is the
 * honest single answer; where none exists the hottest is, because that is the
 * one that decides whether anything throttles.
 */
export function summarize(readings: readonly SensorReading[]): SensorSummary | null {
  if (readings.length === 0) return null;

  const values = readings.map((reading) => reading.celsius);
  const headline = readings.find((reading) =>
    /^(package|composite|tctl|tdie)/i.test(reading.label),
  );

  return {
    celsius: headline?.celsius ?? Math.max(...values),
    lowest: Math.min(...values),
    highest: Math.max(...values),
    count: readings.length,
  };
}

/** Readings from the processor's own sensors. */
export function cpuSensors(readings: readonly SensorReading[]): SensorSummary | null {
  return summarize(readings.filter((reading) => CPU_CHIPS.includes(reading.chip)));
}

/**
 * Readings belonging to one block device.
 *
 * hwmon names an NVMe controller `nvme0` and its block device is `nvme0n1`, so
 * the match is a prefix rather than an equality. Two drives report the same
 * chip name, which is why the device is carried at all.
 */
export function deviceSensors(
  readings: readonly SensorReading[],
  blockDevice: string,
): SensorSummary | null {
  return summarize(
    readings.filter((reading) => reading.device !== null && blockDevice.startsWith(reading.device)),
  );
}

/**
 * Everything that belongs to no section above.
 *
 * A wireless card or a chipset sensor is worth showing, but not worth a heading
 * of its own — it goes in one line at the end rather than inventing a section.
 */
export function looseSensors(
  readings: readonly SensorReading[],
  blockDevices: readonly string[],
): SensorReading[] {
  return readings.filter((reading) => {
    if (CPU_CHIPS.includes(reading.chip)) return false;
    if (
      reading.device !== null &&
      blockDevices.some((name) => name.startsWith(reading.device ?? ''))
    ) {
      return false;
    }
    return true;
  });
}

export interface MemorySummary {
  /** `DDR5`, `Low-Power-DDR3-RAM` — whatever the controller calls it. */
  type: string;
  /** `8 × 4 GiB`, or a plain count where the modules differ. */
  modules: string;
  /** `8/8`, or null where the controller did not say how many slots exist. */
  slots: string | null;
}

/**
 * The memory a machine has, as three facts rather than eight rows.
 *
 * Listing eight identical modules spread one fact over eight lines and buried
 * the only part anyone acts on. What a reader wants is the type, the size of a
 * module, and whether a slot is free.
 */
export function summarizeMemory(
  modules: readonly { sizeBytes: number; type: string | null }[],
  slots: number | null,
): MemorySummary | null {
  if (modules.length === 0) return null;

  const kinds = [...new Set(modules.map((module) => module.type).filter(Boolean))];
  const sizes = [...new Set(modules.map((module) => module.sizeBytes))];

  return {
    type: kinds.length > 0 ? kinds.join(' + ') : 'unknown',
    // Identical modules are the normal case and read as "8 × 4 GiB"; a mixed
    // set is unusual enough to say plainly rather than average away.
    modules:
      sizes.length === 1 && sizes[0] !== undefined
        ? `${modules.length} × ${gibibytes(sizes[0])}`
        : `${modules.length} mixed`,
    slots: slots !== null && slots > 0 ? `${modules.length}/${slots}` : null,
  };
}

function gibibytes(bytes: number): string {
  const value = bytes / 1024 ** 3;
  return `${Number.isInteger(value) ? value : value.toFixed(1)} GiB`;
}
