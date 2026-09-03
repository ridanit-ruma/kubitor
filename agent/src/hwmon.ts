import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

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
export async function readHwmonTemperatures(root = HWMON_ROOT): Promise<Record<string, number>> {
  const temps: Record<string, number> = {};

  let chips: string[];
  try {
    chips = await readdir(root);
  } catch {
    // No hwmon at all: a container without the host sysfs, or a platform that
    // has none. Reporting nothing is correct.
    return temps;
  }

  for (const chip of chips) {
    const chipDir = join(root, chip);
    const chipName = (await maybeRead(join(chipDir, 'name')))?.trim() ?? chip;

    let entries: string[];
    try {
      entries = await readdir(chipDir);
    } catch {
      continue;
    }

    for (const entry of entries) {
      const match = /^temp(\d+)_input$/.exec(entry);
      if (!match) continue;

      const raw = await maybeRead(join(chipDir, entry));
      const celsius = milliCelsiusToCelsius(raw);
      if (celsius === null) continue;

      const label =
        (await maybeRead(join(chipDir, `temp${match[1]}_label`)))?.trim() ?? `temp${match[1]}`;
      temps[`${chipName}.${label}`] = celsius;
    }
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
  return { temps: await readHwmonTemperatures(), cpuMhz: await readCpuMhz() };
}

async function maybeRead(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}
