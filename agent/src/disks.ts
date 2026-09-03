import { readFile, stat, statfs } from 'node:fs/promises';
import { join } from 'node:path';

export interface DiskReading {
  mount: string;
  device: string;
  fsType: string;
  totalBytes: number;
  usedBytes: number;
}

/**
 * The host's mount table, not the container's.
 *
 * `/proc/mounts` inside a pod describes the pod: its overlay root, and the
 * bind mounts kubelet injects. Reading it reported `/etc/hosts` as a 232 GiB
 * ext4 filesystem, which is true of the file's backing device and useless as a
 * statement about storage. The host's init process sees the real table.
 */
const HOST_MOUNTS = '/host/mounts';
/**
 * Where the host's filesystem tree is mounted, if it is.
 *
 * `statfs` has to be called on a path this process can resolve, and a mount
 * point that exists on the host does not exist in the container. Without this
 * the mount table can be read but not measured, so no disk is reported rather
 * than one measured against the wrong filesystem.
 */
const HOST_ROOT = process.env.KUBITOR_HOST_ROOT ?? '/host/fs';

/**
 * Filesystems a person would call a disk.
 *
 * An allow-list rather than a denylist: a machine mounts dozens of pseudo
 * filesystems, and new ones arrive with every kernel. Listing what counts keeps
 * `tmpfs` — which is RAM — from ever being presented as storage.
 */
const REAL_FILESYSTEMS = new Set([
  'ext2',
  'ext3',
  'ext4',
  'xfs',
  'btrfs',
  'zfs',
  'f2fs',
  'bcachefs',
  'vfat',
  'exfat',
  'ntfs',
  'ntfs3',
]);

export interface MountEntry {
  device: string;
  mount: string;
  fsType: string;
}

/** `/proc/mounts` escapes spaces and tabs in octal; unescape before use. */
export function parseMounts(text: string): MountEntry[] {
  const entries: MountEntry[] = [];

  for (const line of text.split('\n')) {
    const [device, mount, fsType] = line.split(' ');
    if (!device || !mount || !fsType) continue;
    if (!REAL_FILESYSTEMS.has(fsType)) continue;

    entries.push({ device: unescapeOctal(device), mount: unescapeOctal(mount), fsType });
  }

  return entries;
}

function unescapeOctal(value: string): string {
  return value.replace(/\\(\d{3})/g, (_, digits: string) =>
    String.fromCharCode(Number.parseInt(digits, 8)),
  );
}

export async function readDisks(
  mounts = HOST_MOUNTS,
  hostRoot = HOST_ROOT,
): Promise<DiskReading[]> {
  let text: string;
  try {
    text = await readFile(mounts, 'utf8');
  } catch {
    return [];
  }

  const readings: DiskReading[] = [];
  // One device mounted twice — a bind mount, or a btrfs subvolume — is one disk.
  const seen = new Set<string>();

  for (const entry of parseMounts(text)) {
    if (seen.has(entry.device)) continue;

    const path = join(hostRoot, entry.mount);

    try {
      // A filesystem is mounted on a directory. A bind mount of a single file
      // passes every other test here and is not a disk.
      if (!(await stat(path)).isDirectory()) continue;

      const stats = await statfs(path);
      const blockSize = Number(stats.bsize);
      const total = Number(stats.blocks) * blockSize;
      if (total <= 0) continue;

      // `bavail` is what an unprivileged process may use; the gap up to `bfree`
      // is root's reserve, which is used space from a user's point of view.
      const used = total - Number(stats.bavail) * blockSize;

      seen.add(entry.device);
      readings.push({
        mount: entry.mount,
        device: entry.device,
        fsType: entry.fsType,
        totalBytes: total,
        usedBytes: Math.max(0, used),
      });
    } catch {
      // A mount the container cannot resolve is skipped, not reported as empty.
    }
  }

  return readings.sort((a, b) => a.mount.localeCompare(b.mount));
}
