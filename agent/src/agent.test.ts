import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { milliCelsiusToCelsius, readCpuMhz, readHwmonTemperatures, sensorRecord } from './hwmon.js';
import { decideRetry, Sender } from './sender.js';

describe('milliCelsiusToCelsius', () => {
  it('converts milli-degrees to one decimal place', () => {
    expect(milliCelsiusToCelsius('41500')).toBe(41.5);
    expect(milliCelsiusToCelsius('0')).toBe(0);
  });

  /**
   * Some drivers return ENODATA while idle — iwlwifi does it routinely — and an
   * empty read coerced to 0 puts a false temperature on the dashboard.
   */
  it('rejects an unreadable sensor rather than calling it 0 °C', () => {
    expect(milliCelsiusToCelsius(null)).toBeNull();
    expect(milliCelsiusToCelsius('')).toBeNull();
    expect(milliCelsiusToCelsius('   ')).toBeNull();
    expect(milliCelsiusToCelsius('not-a-number')).toBeNull();
  });
});

describe('readHwmonTemperatures', () => {
  function fakeHwmon(): string {
    const root = mkdtempSync(join(tmpdir(), 'kubitor-hwmon-'));

    const coretemp = join(root, 'hwmon0');
    mkdirSync(coretemp);
    writeFileSync(join(coretemp, 'name'), 'coretemp\n');
    writeFileSync(join(coretemp, 'temp1_input'), '41500\n');
    writeFileSync(join(coretemp, 'temp1_label'), 'Package id 0\n');
    writeFileSync(join(coretemp, 'temp2_input'), '39000\n');

    // A chip whose sensor cannot be read right now.
    const idle = join(root, 'hwmon1');
    mkdirSync(idle);
    writeFileSync(join(idle, 'name'), 'iwlwifi_1\n');
    writeFileSync(join(idle, 'temp1_input'), '\n');

    return root;
  }

  it('labels each reading by chip and sensor', async () => {
    const temps = sensorRecord(await readHwmonTemperatures(fakeHwmon()));

    expect(temps['coretemp.Package id 0']).toBe(41.5);
    expect(temps['coretemp.temp2']).toBe(39);
  });

  it('omits a sensor it could not read', async () => {
    const temps = sensorRecord(await readHwmonTemperatures(fakeHwmon()));

    expect(Object.keys(temps)).not.toContain('iwlwifi_1.temp1');
  });

  /**
   * Two NVMe drives both call their chip `nvme`. Keyed by chip alone, the
   * second drive's reading silently replaced the first's.
   */
  it('keeps two chips of the same name apart', () => {
    const temps = sensorRecord([
      { chip: 'nvme', device: 'nvme0', label: 'Composite', celsius: 44.9 },
      { chip: 'nvme', device: 'nvme1', label: 'Composite', celsius: 38.9 },
    ]);

    expect(temps['nvme0.Composite']).toBe(44.9);
    expect(temps['nvme1.Composite']).toBe(38.9);
  });

  it('falls back to the chip name where no device resolves', () => {
    const temps = sensorRecord([
      { chip: 'coretemp', device: null, label: 'Package id 0', celsius: 41.5 },
    ]);

    expect(temps['coretemp.Package id 0']).toBe(41.5);
  });

  it('reports nothing rather than failing where there is no hwmon', async () => {
    expect(await readHwmonTemperatures('/nonexistent/hwmon')).toEqual([]);
  });
});

describe('readCpuMhz', () => {
  it('averages the per-core clocks', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'kubitor-cpu-')), 'cpuinfo');
    writeFileSync(
      path,
      'processor\t: 0\ncpu MHz\t\t: 2000.000\n\nprocessor\t: 1\ncpu MHz\t\t: 3000.000\n',
    );

    expect(await readCpuMhz(path)).toBe(2500);
  });

  it('returns null where the file does not exist', async () => {
    expect(await readCpuMhz('/nonexistent/cpuinfo')).toBeNull();
  });
});

describe('decideRetry', () => {
  /**
   * The wedge rule, from the client side. Retrying a 4xx forever means one
   * malformed row silences the node permanently.
   */
  it('advances past a batch the server refused', () => {
    for (const status of [400, 401, 403, 404, 422]) {
      expect(decideRetry(status).advance, String(status)).toBe(true);
    }
  });

  it('keeps a batch the server could not handle yet', () => {
    for (const status of [429, 500, 502, 503]) {
      expect(decideRetry(status).advance, String(status)).toBe(false);
    }
  });

  it('keeps a batch that never reached the server', () => {
    expect(decideRetry(null).advance).toBe(false);
  });

  it('advances on success', () => {
    expect(decideRetry(202).advance).toBe(true);
  });
});

describe('Sender', () => {
  function sender(status: number | Error, maxBuffered = 100): Sender {
    const fetchImpl = vi.fn(async () => {
      if (status instanceof Error) throw status;
      return new Response(null, { status });
    }) as unknown as typeof fetch;

    return new Sender({
      endpoint: 'http://server/api/ingest/hardware',
      token: 'token',
      maxBuffered,
      fetchImpl,
    });
  }

  it('clears the buffer once the server accepts', async () => {
    const outbox = sender(202);
    outbox.enqueue({ at: 1 });

    expect((await outbox.flush()).advance).toBe(true);
    expect(outbox.pending).toBe(0);
  });

  it('keeps the buffer when the server is unreachable', async () => {
    const outbox = sender(new Error('ECONNREFUSED'));
    outbox.enqueue({ at: 1 });

    expect((await outbox.flush()).advance).toBe(false);
    expect(outbox.pending).toBe(1);
  });

  it('advances past a rejected batch so the stream cannot wedge', async () => {
    const outbox = sender(400);
    outbox.enqueue({ at: 1 });

    await outbox.flush();

    expect(outbox.pending).toBe(0);
  });

  /** A node cut off from the server must not grow until it is OOM-killed. */
  it('drops the oldest rows once the buffer is full', async () => {
    const outbox = sender(500, 3);
    for (let index = 0; index < 10; index += 1) outbox.enqueue({ at: index });

    expect(outbox.pending).toBe(3);
  });

  it('does nothing with an empty buffer', async () => {
    expect(await sender(500).flush()).toEqual({ advance: true, status: null });
  });
});
