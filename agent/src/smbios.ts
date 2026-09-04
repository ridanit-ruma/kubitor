import { readFile } from 'node:fs/promises';

/**
 * SMBIOS, which is where a machine's own description actually lives.
 *
 * The kernel's EDAC interface answers the same questions and answers some of
 * them wrong: on Alder Lake it reports LPDDR5 as `Low-Power-DDR3-RAM` and 3 GiB
 * devices as 4 GiB, because a memory controller only knows the subset of
 * geometry it has to program. Firmware knows what is soldered on the board.
 *
 * The table is `/sys/firmware/dmi/tables/DMI`, mode 0400 owned by root, so this
 * parser reads a copy placed by a short-lived container that runs as root and
 * does nothing else. Absent that copy, the caller falls back to EDAC.
 */

/** Where the init container leaves the table for this process to read. */
export const DMI_TABLE = process.env.KUBITOR_DMI_TABLE ?? '/run/kubitor/dmi/DMI';

export interface SmbiosStructure {
  type: number;
  handle: number;
  /** The formatted area, including the four-byte header. */
  data: Buffer;
  /** The structure's string set, indexed from one by the fields that name it. */
  strings: string[];
}

export interface MemoryDevice {
  /** `Controller0-ChannelA`, `DIMM_A1` — where the board says it is. */
  locator: string | null;
  bankLocator: string | null;
  /** Zero for a slot with nothing in it; null where firmware would not say. */
  sizeBytes: number | null;
  /** `SODIMM`, `DIMM`, `Row of chips` — soldered memory is the last one. */
  formFactor: string | null;
  /** `DDR5`, `LPDDR5`. What the modules actually are. */
  type: string | null;
  /** What the part is rated for, in MT/s. */
  speedMts: number | null;
  /** What it was configured to run at, which is the speed it runs at. */
  configuredSpeedMts: number | null;
  manufacturer: string | null;
  partNumber: string | null;
  rank: number | null;
  dataWidthBits: number | null;
}

/** SMBIOS 3.8, table 76. */
const MEMORY_TYPES: Record<number, string> = {
  1: 'Other',
  2: 'Unknown',
  3: 'DRAM',
  4: 'EDRAM',
  5: 'VRAM',
  6: 'SRAM',
  7: 'RAM',
  8: 'ROM',
  9: 'Flash',
  10: 'EEPROM',
  11: 'FEPROM',
  12: 'EPROM',
  13: 'CDRAM',
  14: '3DRAM',
  15: 'SDRAM',
  16: 'SGRAM',
  17: 'RDRAM',
  18: 'DDR',
  19: 'DDR2',
  20: 'DDR2 FB-DIMM',
  24: 'DDR3',
  25: 'FBD2',
  26: 'DDR4',
  27: 'LPDDR',
  28: 'LPDDR2',
  29: 'LPDDR3',
  30: 'LPDDR4',
  31: 'Logical non-volatile device',
  32: 'HBM',
  33: 'HBM2',
  34: 'DDR5',
  35: 'LPDDR5',
  36: 'HBM3',
  37: 'LPDDR5X',
};

/** SMBIOS 3.8, table 74. */
const FORM_FACTORS: Record<number, string> = {
  1: 'Other',
  2: 'Unknown',
  3: 'SIMM',
  4: 'SIP',
  5: 'Chip',
  6: 'DIP',
  7: 'ZIP',
  8: 'Proprietary card',
  9: 'DIMM',
  10: 'TSOP',
  11: 'Row of chips',
  12: 'RIMM',
  13: 'SODIMM',
  14: 'SRIMM',
  15: 'FB-DIMM',
  16: 'Die',
  17: 'CAMM',
};

/** The end-of-table marker; nothing after it is a structure. */
const END_OF_TABLE = 127;

/**
 * Walks the structure table.
 *
 * Every structure is a fixed formatted area whose length the header carries,
 * followed by its strings, terminated by two zero bytes. Firmware from any
 * decade may hold fields this build has never heard of, so the length is
 * trusted for the walk and every field is bounds-checked before it is read.
 */
export function parseStructures(table: Buffer): SmbiosStructure[] {
  const structures: SmbiosStructure[] = [];
  let at = 0;

  while (at + 4 <= table.length) {
    const type = table[at] as number;
    const length = table[at + 1] as number;
    // A length shorter than the header means the table is not what it claims;
    // walking on from here would read arbitrary bytes as structures.
    if (length < 4 || at + length > table.length) break;

    const data = table.subarray(at, at + length);

    let end = at + length;
    while (end + 1 < table.length && !(table[end] === 0 && table[end + 1] === 0)) end += 1;

    const strings = table
      .subarray(at + length, end)
      .toString('latin1')
      .split('\0')
      .filter((value) => value.length > 0);

    structures.push({ type, handle: data.readUInt16LE(2), data, strings });
    if (type === END_OF_TABLE) break;

    at = end + 2;
  }

  return structures;
}

/** Every memory slot the firmware describes, filled or empty. */
export function memoryDevices(table: Buffer): MemoryDevice[] {
  return parseStructures(table)
    .filter((structure) => structure.type === 17)
    .map(readMemoryDevice);
}

function readMemoryDevice(structure: SmbiosStructure): MemoryDevice {
  const { data, strings } = structure;

  const text = (offset: number): string | null => {
    const index = byte(data, offset);
    if (index === null || index === 0) return null;
    return meaningful(strings[index - 1]);
  };

  const rank = byte(data, 0x1b);

  return {
    locator: text(0x10),
    bankLocator: text(0x11),
    sizeBytes: sizeOf(data),
    formFactor: named(FORM_FACTORS, byte(data, 0x0e)),
    type: named(MEMORY_TYPES, byte(data, 0x12)),
    speedMts: speedOf(data, 0x15, 0x54),
    configuredSpeedMts: speedOf(data, 0x20, 0x58),
    manufacturer: text(0x17),
    partNumber: text(0x1a),
    rank: rank === null || (rank & 0x0f) === 0 ? null : rank & 0x0f,
    dataWidthBits: unknownable(word(data, 0x0a), 0xffff),
  };
}

/**
 * The device's capacity.
 *
 * Zero means the slot is empty, which is a fact worth keeping — it is how a
 * machine says it has room. `0x7fff` means the value did not fit in the word
 * and lives in the extended field; bit 15 says whether the units are kibibytes.
 */
function sizeOf(data: Buffer): number | null {
  const size = word(data, 0x0c);
  if (size === null || size === 0xffff) return null;
  if (size === 0) return 0;

  if (size === 0x7fff) {
    const extended = dword(data, 0x1c);
    // The extended field is in mebibytes, with its top bit reserved.
    return extended === null ? null : (extended & 0x7fffffff) * 1024 ** 2;
  }

  const units = (size & 0x8000) === 0 ? 1024 ** 2 : 1024;
  return (size & 0x7fff) * units;
}

/** A transfer rate, taking the extended field when the word overflows. */
function speedOf(data: Buffer, offset: number, extendedOffset: number): number | null {
  const speed = word(data, offset);
  if (speed === null || speed === 0) return null;
  if (speed !== 0xffff) return speed;
  return dword(data, extendedOffset);
}

function named(table: Record<number, string>, code: number | null): string | null {
  if (code === null) return null;
  const name = table[code];
  // "Unknown" and "Other" are firmware declining to answer; so is a code this
  // build has no name for. None of them belong on screen as a fact.
  return name === undefined || name === 'Unknown' || name === 'Other' ? null : name;
}

/**
 * A string the firmware actually filled in.
 *
 * Boards ship with placeholder text in fields nobody populated, and printing
 * `Not Specified` as a manufacturer is worse than printing nothing.
 */
function meaningful(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  if (trimmed === '') return null;
  return /^(not specified|unknown|none|to be filled by o\.?e\.?m\.?|n\/a|\[empty\])$/i.test(trimmed)
    ? null
    : trimmed;
}

function byte(data: Buffer, offset: number): number | null {
  return offset < data.length ? (data[offset] as number) : null;
}

function word(data: Buffer, offset: number): number | null {
  return offset + 2 <= data.length ? data.readUInt16LE(offset) : null;
}

function dword(data: Buffer, offset: number): number | null {
  return offset + 4 <= data.length ? data.readUInt32LE(offset) : null;
}

function unknownable(value: number | null, unknown: number): number | null {
  return value === null || value === unknown || value === 0 ? null : value;
}

/** The table as the firmware left it, or null where this agent cannot read it. */
export async function readDmiTable(path = DMI_TABLE): Promise<Buffer | null> {
  try {
    const table = await readFile(path);
    return table.length >= 4 ? table : null;
  } catch {
    return null;
  }
}
