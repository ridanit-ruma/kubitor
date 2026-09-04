import { readdir, readFile, readlink } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

export interface SensorReading {
  /** Driver name: `coretemp`, `nvme`, `iwlwifi_1`. */
  chip: string;
  /**
   * The device the chip belongs to, where it can be resolved.
   *
   * Two NVMe drives both call their chip `nvme`, so the chip name alone cannot
   * tell them apart — and keyed by chip alone, one drive's reading silently
   * replaced the other's. This is `nvme0` or `nvme1`, which a block device name
   * begins with.
   */
  device: string | null;
  label: string;
  celsius: number;
}

export interface HardwareReading {
  /** Sensor label to degrees Celsius. */
  temps: Record<string, number>;
  cpuMhz: number | null;
}

const HWMON_ROOT = '/sys/class/hwmon';
const CPUINFO = '/proc/cpuinfo';

/**
 * Reads temperatures from `/sys/class/hwmon`.
 *
 * Sensors that cannot be read are **omitted, never reported as 0 °C**. Some
 * drivers return ENODATA when the device is idle — iwlwifi does it routinely —
 * and coercing that to zero puts a false reading on the dashboard and can fire
 * a "suspiciously cold" alert.
 */
export async function readHwmonTemperatures(root = HWMON_ROOT): Promise<SensorReading[]> {
  const readings: SensorReading[] = [];

  let chips: string[];
  try {
    chips = await readdir(root);
  } catch {
    // No hwmon at all: a container without the host sysfs, or a platform that
    // has none. Reporting nothing is correct.
    return readings;
  }

  for (const chip of chips.sort()) {
    const chipDir = join(root, chip);
    const chipName = (await maybeRead(join(chipDir, 'name')))?.trim() ?? chip;
    const device = await deviceOf(chipDir);

    let entries: string[];
    try {
      entries = await readdir(chipDir);
    } catch {
      continue;
    }

    for (const entry of entries.sort()) {
      const match = /^temp(\d+)_input$/.exec(entry);
      if (!match) continue;

      const raw = await maybeRead(join(chipDir, entry));
      const celsius = milliCelsiusToCelsius(raw);
      if (celsius === null) continue;

      const label =
        (await maybeRead(join(chipDir, `temp${match[1]}_label`)))?.trim() ?? `temp${match[1]}`;
      readings.push({ chip: chipName, device, label, celsius });
    }
  }

  return readings;
}

/** `.../nvme/nvme1` becomes `nvme1`, which `nvme1n1` begins with. */
async function deviceOf(chipDir: string): Promise<string | null> {
  try {
    const target = await readlink(join(chipDir, 'device'));
    const name = basename(resolve(chipDir, target));
    return name.length > 0 ? name : null;
  } catch {
    return null;
  }
}

/**
 * Sensors as a flat record, for the history facet.
 *
 * Keyed by device where there is one, so two drives reporting the same chip
 * name keep their own readings instead of one overwriting the other.
 */
export function sensorRecord(readings: readonly SensorReading[]): Record<string, number> {
  const temps: Record<string, number> = {};
  for (const reading of readings) {
    temps[`${reading.device ?? reading.chip}.${reading.label}`] = reading.celsius;
  }
  return temps;
}

/**
 * hwmon reports milli-degrees. An unreadable sensor yields null rather than
 * zero — see the note above; this is the conversion the distinction lives in.
 */
export function milliCelsiusToCelsius(raw: string | null): number | null {
  if (raw === null) return null;

  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;

  const value = Number(trimmed);
  if (!Number.isFinite(value)) return null;

  return Math.round((value / 1000) * 10) / 10;
}

/** Mean current clock across cores, which is what a dashboard can use. */
export async function readCpuMhz(path = CPUINFO): Promise<number | null> {
  const text = await maybeRead(path);
  if (text === null) return null;

  const values = [...text.matchAll(/^cpu MHz\s*:\s*([\d.]+)$/gm)].map((match) => Number(match[1]));
  const usable = values.filter((value) => Number.isFinite(value));
  if (usable.length === 0) return null;

  return Math.round(usable.reduce((total, value) => total + value, 0) / usable.length);
}

export async function readHardware(): Promise<HardwareReading> {
  return { temps: sensorRecord(await readHwmonTemperatures()), cpuMhz: await readCpuMhz() };
}

async function maybeRead(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}
