import { copyFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { DMI_TABLE } from './smbios.js';

/**
 * Copies the SMBIOS table where the agent can read it, and exits.
 *
 * `/sys/firmware/dmi/tables/DMI` is mode 0400 owned by root, so nothing running
 * as `nobody` can open it — and what it holds, the description of the memory
 * actually soldered to the board, is not available anywhere else. This runs as
 * an init container: uid 0, every capability dropped, one file in and one file
 * out. Ordinary ownership is enough for root to read a file root owns, so no
 * capability and no privilege escalation is involved.
 *
 * The long-running agent keeps running as nobody with no access to the host's
 * firmware at all. A machine's memory does not change while it is powered, so
 * one read at pod start is the whole requirement.
 *
 * Failure is not fatal: the pod starts anyway and the agent reads what the
 * kernel exposes instead. A cluster that will not admit a root init container
 * can delete it and lose nothing but the memory type.
 */
const SOURCE = process.env.KUBITOR_DMI_SOURCE ?? '/host/dmi/DMI';

async function main(): Promise<void> {
  try {
    await mkdir(dirname(DMI_TABLE), { recursive: true });
    await copyFile(SOURCE, DMI_TABLE);
    console.log(`kubitor: copied ${SOURCE} to ${DMI_TABLE}`);
  } catch (error) {
    // Every path here is survivable: no SMBIOS on this architecture, no mount,
    // or a kernel built without the DMI sysfs entries.
    console.log(`kubitor: no SMBIOS table (${(error as Error).message})`);
  }
}

await main();
