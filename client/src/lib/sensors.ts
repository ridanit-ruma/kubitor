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
 * chip name, which is why the device is carried at all — and the prefix has to
 * end on a boundary, or `nvme1` would claim `nvme10n1`'s temperature on the
 * day someone builds a machine with eleven drives.
 */
export function deviceSensors(
  readings: readonly SensorReading[],
  blockDevice: string,
): SensorSummary | null {
  return summarize(readings.filter((reading) => owns(reading.device, blockDevice)));
}

/** `nvme0` owns `nvme0n1`; it does not own `nvme01n1`, and there is no such thing. */
function owns(device: string | null, blockDevice: string): boolean {
  if (device === null || !blockDevice.startsWith(device)) return false;
  const rest = blockDevice.slice(device.length);
  // What follows the controller's name is the namespace: `n1`, `n2`. A digit
  // there would mean the name itself was longer than the one we matched.
  return rest === '' || /^[a-z]/.test(rest);
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
    if (blockDevices.some((name) => owns(reading.device, name))) return false;
    return true;
  });
}

export interface MemorySummary {
  /** `LPDDR5`, `DDR5` — what the firmware says is on the board. */
  type: string;
  /** `8 × 3 GiB`, or a plain count where the modules differ. */
  modules: string;
  /** `8/8`, or null where nothing said how many slots exist. */
  slots: string | null;
  /** `5200 / 6600 MT/s` — running speed against what the part is rated for. */
  speed: string | null;
  /** `SODIMM`, `Row of chips`. Soldered memory is worth knowing before ordering. */
  formFactor: string | null;
}

/**
 * The memory a machine has, as three facts rather than eight rows.
 *
 * Listing eight identical modules spread one fact over eight lines and buried
 * the only part anyone acts on. What a reader wants is the type, the size of a
 * module, and whether a slot is free.
 */
export function summarizeMemory(
  modules: readonly MemoryFacts[],
  slots: number | null,
): MemorySummary | null {
  if (modules.length === 0) return null;

  const kinds = [...new Set(modules.map((module) => module.type).filter(Boolean))];
  const sizes = [...new Set(modules.map((module) => module.sizeBytes))];

  return {
    type: kinds.length > 0 ? kinds.join(' + ') : 'unknown',
    // Identical modules are the normal case and read as "8 × 3 GiB"; a mixed
    // set is unusual enough to say plainly rather than average away.
    modules:
      sizes.length === 1 && sizes[0] !== undefined
        ? `${modules.length} × ${gibibytes(sizes[0])}`
        : `${modules.length} mixed`,
    slots: slots !== null && slots > 0 ? `${modules.length}/${slots}` : null,
    speed: speedOf(modules),
    formFactor:
      [...new Set(modules.map((module) => module.formFactor).filter(Boolean))].join(' + ') || null,
  };
}

export interface MemoryFacts {
  sizeBytes: number;
  type: string | null;
  formFactor?: string | null;
  speedMts?: number | null;
  configuredSpeedMts?: number | null;
}

/**
 * What the memory runs at, and what it could run at.
 *
 * These differ more often than not — firmware clocks a 6400 part at 5200
 * because that is what the controller supports with every slot filled — and the
 * gap is the whole reason to print the rated figure beside the real one.
 */
function speedOf(modules: readonly MemoryFacts[]): string | null {
  const configured = highest(modules.map((module) => module.configuredSpeedMts ?? null));
  const rated = highest(modules.map((module) => module.speedMts ?? null));
  if (configured === null && rated === null) return null;

  const running = configured ?? rated;
  if (rated === null || running === null || rated === running) return `${running} MT/s`;
  return `${running} / ${rated} MT/s`;
}

function highest(values: readonly (number | null)[]): number | null {
  const usable = values.filter((value): value is number => value !== null && value > 0);
  return usable.length === 0 ? null : Math.max(...usable);
}

function gibibytes(bytes: number): string {
  const value = bytes / 1024 ** 3;
  return `${Number.isInteger(value) ? value : value.toFixed(1)} GiB`;
}
