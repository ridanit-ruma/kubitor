import { describe, expect, it } from 'vitest';
import {
  cpuSensors,
  deviceSensors,
  looseSensors,
  type SensorReading,
  summarizeMemory,
} from './sensors';

const READINGS: SensorReading[] = [
  { chip: 'coretemp', device: null, label: 'Package id 0', celsius: 39 },
  { chip: 'coretemp', device: null, label: 'Core 0', celsius: 34 },
  { chip: 'coretemp', device: null, label: 'Core 1', celsius: 38 },
  { chip: 'nvme', device: 'nvme0', label: 'Composite', celsius: 44.9 },
  { chip: 'nvme', device: 'nvme0', label: 'Sensor 2', celsius: 41.9 },
  { chip: 'nvme', device: 'nvme1', label: 'Composite', celsius: 38.9 },
  { chip: 'iwlwifi_1', device: null, label: 'temp1', celsius: 31 },
];

describe('cpuSensors', () => {
  it('speaks for the die with the package sensor, not the hottest core', () => {
    expect(cpuSensors(READINGS)?.celsius).toBe(39);
  });

  it('keeps the range and the count behind it', () => {
    const summary = cpuSensors(READINGS);
    expect(summary?.lowest).toBe(34);
    expect(summary?.highest).toBe(39);
    expect(summary?.count).toBe(3);
  });

  it('has nothing to say on a machine with no CPU sensor', () => {
    expect(cpuSensors([READINGS[3] as SensorReading])).toBeNull();
  });
});

describe('deviceSensors', () => {
  /**
   * Both drives call their chip `nvme`. Without the device, one reading
   * replaced the other and neither could sit beside the disk it describes.
   */
  it('gives each drive its own reading', () => {
    expect(deviceSensors(READINGS, 'nvme0n1')?.celsius).toBe(44.9);
    expect(deviceSensors(READINGS, 'nvme1n1')?.celsius).toBe(38.9);
  });

  it('matches a controller to its block device by prefix', () => {
    // hwmon names the controller `nvme0`; the block device is `nvme0n1`.
    expect(deviceSensors(READINGS, 'nvme0n1')?.count).toBe(2);
  });

  it('reports nothing for a drive with no sensor', () => {
    expect(deviceSensors(READINGS, 'sda')).toBeNull();
  });
});

describe('looseSensors', () => {
  it('keeps what belongs to no section', () => {
    const loose = looseSensors(READINGS, ['nvme0n1', 'nvme1n1']);
    expect(loose.map((reading) => reading.chip)).toEqual(['iwlwifi_1']);
  });

  it('does not orphan a drive reading when that drive is not listed', () => {
    const loose = looseSensors(READINGS, ['nvme0n1']);
    expect(loose.some((reading) => reading.device === 'nvme1')).toBe(true);
  });
});

describe('summarizeMemory', () => {
  const module = (sizeBytes: number, type: string | null) => ({ sizeBytes, type });

  /** Eight identical rows spread one fact over eight lines. */
  it('states the type, the module size and the slots as three facts', () => {
    const modules = Array.from({ length: 8 }, () => module(4 * 1024 ** 3, 'Low-Power-DDR3-RAM'));

    expect(summarizeMemory(modules, 8)).toEqual({
      type: 'Low-Power-DDR3-RAM',
      modules: '8 × 4 GiB',
      slots: '8/8',
    });
  });

  it('says how many slots are still free', () => {
    const modules = [module(16 * 1024 ** 3, 'DDR5'), module(16 * 1024 ** 3, 'DDR5')];
    expect(summarizeMemory(modules, 4)?.slots).toBe('2/4');
  });

  /** Averaging a mixed set away would state a size no module actually is. */
  it('refuses to average a mixed set into one size', () => {
    const modules = [module(8 * 1024 ** 3, 'DDR4'), module(16 * 1024 ** 3, 'DDR4')];
    expect(summarizeMemory(modules, 2)?.modules).toBe('2 mixed');
  });

  it('omits the slot count where the controller did not give one', () => {
    expect(summarizeMemory([module(4 * 1024 ** 3, 'DDR4')], null)?.slots).toBeNull();
  });

  it('has nothing to summarize without modules', () => {
    expect(summarizeMemory([], 4)).toBeNull();
  });
});
