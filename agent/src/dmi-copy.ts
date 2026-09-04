import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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

/**
 * World-readable, because the process that needs it is not this one.
 *
 * A plain copy carries the source's mode, and the source is 0400 owned by
 * root — so the first version of this left the agent unable to read the file
 * that had just been placed there for it. The table describes what is soldered
 * to a board; it is not a secret, and the only readers are the containers of
 * this pod.
 */
const READABLE = 0o444;

/** Places the table where a process that is not root can read it. */
export async function copyTable(source: string, destination: string): Promise<number> {
  await mkdir(dirname(destination), { recursive: true });
  const table = await readFile(source);
  // The copy this leaves is read-only, and root without CAP_DAC_OVERRIDE — which
  // this container drops along with every other — may not write to a read-only
  // file it owns. On a pod whose containers restarted, the volume still holds
  // the previous copy, so it goes before the new one is written.
  await rm(destination, { force: true });
  await writeFile(destination, table, { mode: READABLE });
  // The mode argument applies only when the write creates the file, and this
  // container runs again on every restart of the pod.
  await chmod(destination, READABLE);
  return table.length;
}

async function main(): Promise<void> {
  try {
    const bytes = await copyTable(SOURCE, DMI_TABLE);
    console.log(`kubitor: copied ${SOURCE} to ${DMI_TABLE} (${bytes} bytes)`);
  } catch (error) {
    // Every path here is survivable: no SMBIOS on this architecture, no mount,
    // or a kernel built without the DMI sysfs entries.
    console.log(`kubitor: no SMBIOS table (${(error as Error).message})`);
  }
}

// Entry point only when run as one: importing this for its copy must not copy.
if (process.argv[1]?.endsWith('dmi-copy.js')) await main();
