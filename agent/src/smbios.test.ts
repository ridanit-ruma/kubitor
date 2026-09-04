import { describe, expect, it } from 'vitest';
import { memoryDevices, parseStructures } from './smbios.js';

/**
 * A type 17 structure built to match a real machine's `dmidecode -t 17`.
 *
 * The node this was taken from reports LPDDR5 at 6600 MT/s configured to 5200,
 * soldered as a row of chips, 3 GiB per device — every one of which the kernel's
 * EDAC interface gets wrong on the same hardware.
 */
function memoryDevice({
  sizeMebibytes = 3072,
  formFactor = 0x0b,
  type = 0x23,
  speed = 6600,
  configured = 5200,
  length = 0x5c,
}: {
  sizeMebibytes?: number;
  formFactor?: number;
  type?: number;
  speed?: number;
  configured?: number;
  length?: number;
} = {}): Buffer {
  const data = Buffer.alloc(length);
  data[0] = 17;
  data[1] = length;
  data.writeUInt16LE(0x0028, 2);
  data.writeUInt16LE(16, 0x0a); // Data width, bits
  data.writeUInt16LE(sizeMebibytes, 0x0c);
  data[0x0e] = formFactor;
  data[0x10] = 1; // Device locator, first string
  data[0x11] = 2; // Bank locator, second string
  data[0x12] = type;
  data.writeUInt16LE(speed, 0x15);
  data[0x17] = 3; // Manufacturer
  // Fields the older, shorter structures never had.
  if (length > 0x1b) {
    data[0x1a] = 0; // Part number: not specified
    data[0x1b] = 2; // Rank, in the low nibble
  }
  if (length > 0x21) data.writeUInt16LE(configured, 0x20);

  const strings = Buffer.from('Controller0-ChannelA\0BANK 0\0Micron Technology\0\0', 'latin1');
  return Buffer.concat([data, strings]);
}

/** The marker every table ends with. */
const endOfTable = Buffer.from([127, 4, 0, 0, 0, 0]);

describe('parseStructures', () => {
  it('walks a table and keeps each structure with its own strings', () => {
    const structures = parseStructures(Buffer.concat([memoryDevice(), endOfTable]));

    expect(structures.map((structure) => structure.type)).toEqual([17, 127]);
    expect(structures[0]?.strings).toEqual(['Controller0-ChannelA', 'BANK 0', 'Micron Technology']);
  });

  it('stops at the end of the table rather than reading past it', () => {
    const table = Buffer.concat([endOfTable, memoryDevice()]);
    expect(parseStructures(table)).toHaveLength(1);
  });

  it('refuses to walk a structure that claims a length shorter than its header', () => {
    expect(parseStructures(Buffer.from([17, 2, 0, 0, 0, 0]))).toEqual([]);
  });

  it('reads nothing out of a truncated table', () => {
    expect(parseStructures(Buffer.from([17, 92, 0]))).toEqual([]);
  });
});

describe('memoryDevices', () => {
  it('reports what the firmware knows and the kernel gets wrong', () => {
    const [device] = memoryDevices(Buffer.concat([memoryDevice(), endOfTable]));

    expect(device?.type).toBe('LPDDR5');
    expect(device?.sizeBytes).toBe(3 * 1024 ** 3);
    expect(device?.formFactor).toBe('Row of chips');
    expect(device?.speedMts).toBe(6600);
    expect(device?.configuredSpeedMts).toBe(5200);
    expect(device?.manufacturer).toBe('Micron Technology');
    expect(device?.locator).toBe('Controller0-ChannelA');
    expect(device?.rank).toBe(2);
    expect(device?.dataWidthBits).toBe(16);
  });

  /** A slot with nothing in it is a fact: it is how a machine says it has room. */
  it('reports an empty slot as a slot of size zero', () => {
    const [device] = memoryDevices(Buffer.concat([memoryDevice({ sizeMebibytes: 0 }), endOfTable]));
    expect(device?.sizeBytes).toBe(0);
  });

  it('reads a size too large for the word from the extended field', () => {
    const structure = memoryDevice({ sizeMebibytes: 0x7fff });
    structure.writeUInt32LE(65_536, 0x1c);

    expect(memoryDevices(Buffer.concat([structure, endOfTable]))[0]?.sizeBytes).toBe(
      64 * 1024 ** 3,
    );
  });

  it('reads a size flagged as kibibytes in that unit', () => {
    // Bit 15 set means the value counts kibibytes, not mebibytes.
    const structure = memoryDevice({ sizeMebibytes: 0x8000 | 512 });
    expect(memoryDevices(Buffer.concat([structure, endOfTable]))[0]?.sizeBytes).toBe(512 * 1024);
  });

  /** Firmware declining to answer must not become a fact on a screen. */
  it('reports nothing rather than "Unknown" for a field the firmware left blank', () => {
    const structure = memoryDevice({ type: 0x02, formFactor: 0x02, speed: 0, configured: 0 });
    const [device] = memoryDevices(Buffer.concat([structure, endOfTable]));

    expect(device?.type).toBeNull();
    expect(device?.formFactor).toBeNull();
    expect(device?.speedMts).toBeNull();
    expect(device?.configuredSpeedMts).toBeNull();
    expect(device?.partNumber).toBeNull();
  });

  it('survives an older structure that stops before the newer fields', () => {
    // SMBIOS 2.3 ended at 0x15; configured speed did not exist yet.
    const [device] = memoryDevices(Buffer.concat([memoryDevice({ length: 0x17 }), endOfTable]));

    expect(device?.type).toBe('LPDDR5');
    expect(device?.configuredSpeedMts).toBeNull();
    expect(device?.rank).toBeNull();
  });

  it('finds nothing in a table that describes no memory', () => {
    expect(memoryDevices(endOfTable)).toEqual([]);
  });
});
