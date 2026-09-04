import { Bar } from '@/components/resource-card';
import type { BlockDevice, CpuDetail, DiskInfo, GpuInfo, MemoryModule, NicInfo } from '@/lib/api';
import {
  formatBytes,
  formatBytesPerSecond,
  formatCelsius,
  formatCount,
  formatMhz,
  formatOfTotal,
  formatPercent,
} from '@/lib/format';
import {
  cpuSensors,
  deviceSensors,
  looseSensors,
  type SensorReading,
  type SensorSummary,
  summarizeMemory,
} from '@/lib/sensors';

/**
 * One machine, grouped the way a person asks about it.
 *
 * The load a part is under and the description of that part are the same
 * subject, and separating them made a reader scroll between the temperature of
 * a disk and the size of it. Each card below carries what a part is doing, what
 * it is, and how hot it is.
 */

function Card({
  title,
  right,
  children,
  className,
}: {
  title: string;
  right?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={`rounded-lg border border-line bg-card px-4 py-3 ${className ?? ''}`}>
      <div className="flex items-baseline justify-between gap-3">
        <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
          {title}
        </p>
        {right}
      </div>
      {children}
    </section>
  );
}

/** Short facts run together, because each one alone is not worth a line. */
function Facts({ items }: { items: readonly (string | null | undefined)[] }) {
  const usable = items.filter((item): item is string => !!item);
  if (usable.length === 0) return null;

  return <p className="mt-1 font-mono text-xs text-muted-foreground">{usable.join(' · ')}</p>;
}

function Temperature({ summary }: { summary: SensorSummary | null }) {
  if (!summary) return null;

  return (
    <span className="font-mono text-xs tabular">
      {formatCelsius(summary.celsius)}
      {summary.count > 1 && (
        <span className="ml-2 text-muted-foreground">
          {formatCelsius(summary.lowest)}–{formatCelsius(summary.highest)}
        </span>
      )}
    </span>
  );
}

export function Processor({
  cpu,
  percent,
  clockMhz,
  clockMaxMhz,
  loadPercent,
  sensors,
}: {
  cpu: CpuDetail | null;
  percent: number | null;
  clockMhz: number | null;
  clockMaxMhz: number | null;
  loadPercent: number | null;
  sensors: readonly SensorReading[];
}) {
  return (
    <Card title="Processor" right={<Temperature summary={cpuSensors(sensors)} />}>
      <p className="mt-1 font-mono text-2xl font-medium tabular">{formatPercent(percent)}</p>
      <Bar percent={percent} />

      {cpu?.model && <p className="mt-2 text-sm">{cpu.model}</p>}

      <Facts
        items={[
          cpu?.coresPerSocket && cpu.sockets
            ? `${cpu.sockets > 1 ? `${cpu.sockets} × ` : ''}${cpu.coresPerSocket} cores`
            : null,
          cpu?.threads ? `${cpu.threads} threads` : null,
          clockMhz === null ? null : `${formatMhz(clockMhz)} of ${formatMhz(clockMaxMhz)}`,
          loadPercent === null ? null : `load ${formatPercent(loadPercent, 0)}`,
          cpu?.governor,
        ]}
      />

      {cpu && cpu.caches.length > 0 && (
        <Facts
          items={cpu.caches.map((cache) => `${cacheName(cache)} ${formatBytes(cache.sizeBytes)}`)}
        />
      )}

      {cpu && cpu.features.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {cpu.features.map((feature) => (
            <span
              key={feature}
              className="rounded border border-line px-1.5 py-0.5 font-mono text-[10px] uppercase text-muted-foreground"
            >
              {feature}
            </span>
          ))}
        </div>
      )}
    </Card>
  );
}

/** `L1d`, `L1i`, `L2` — the names a person uses, not `L1 Data`. */
function cacheName(cache: { level: number; type: string }): string {
  const suffix = { Data: 'd', Instruction: 'i', Unified: '' }[cache.type] ?? '';
  return `L${cache.level}${suffix}`;
}

export function Memory({
  usedBytes,
  totalBytes,
  percent,
  availableBytes,
  swapUsedBytes,
  swapTotalBytes,
  modules,
  slots,
}: {
  usedBytes: number | null;
  totalBytes: number | null;
  percent: number | null;
  availableBytes: number | null;
  swapUsedBytes: number | null;
  swapTotalBytes: number | null;
  modules: readonly MemoryModule[];
  slots: number | null;
}) {
  return (
    <Card
      title="Memory"
      right={
        <span className="font-mono text-xs tabular text-muted-foreground">
          {formatPercent(percent, 0)}
        </span>
      }
    >
      <p className="mt-1 font-mono text-2xl font-medium tabular">
        {formatOfTotal(usedBytes, totalBytes)}
      </p>
      <Bar percent={percent} />

      <Facts
        items={[
          availableBytes === null ? null : `${formatBytes(availableBytes)} available`,
          swapTotalBytes ? `swap ${formatOfTotal(swapUsedBytes, swapTotalBytes)}` : null,
        ]}
      />

      {/* One line rather than a row per module: eight identical rows spread a
          single fact over eight lines and hid the one that matters. */}
      <Facts items={[summarizeMemory(modules, slots)]} />
    </Card>
  );
}

export function Network({
  rxBytesPerSecond,
  txBytesPerSecond,
  nics,
}: {
  rxBytesPerSecond: number | null;
  txBytesPerSecond: number | null;
  nics: readonly NicInfo[];
}) {
  return (
    <Card
      title="Network"
      right={
        <span className="font-mono text-sm tabular">
          ↓ {formatBytesPerSecond(rxBytesPerSecond)}
          <span className="text-muted-foreground"> · </span>↑{' '}
          {formatBytesPerSecond(txBytesPerSecond)}
        </span>
      }
    >
      {nics.length === 0 ? (
        <p className="mt-1 text-xs text-muted-foreground">Summed across physical interfaces.</p>
      ) : (
        <ul className="mt-2 flex flex-col gap-2">
          {nics.map((nic) => (
            <li key={nic.name}>
              <div className="flex items-baseline justify-between gap-3">
                <span className="truncate font-mono text-sm">{nic.name}</span>
                <span className="shrink-0 font-mono text-xs tabular">
                  ↓ {formatBytesPerSecond(nic.rxBytesPerSecond)}
                  <span className="text-muted-foreground"> · </span>↑{' '}
                  {formatBytesPerSecond(nic.txBytesPerSecond)}
                </span>
              </div>
              <Facts
                items={[
                  nic.state,
                  nic.speedMbps === null ? null : formatLinkSpeed(nic.speedMbps),
                  nic.mtu === null ? null : `MTU ${nic.mtu}`,
                  // Silence is the normal case, so say it only when it is not.
                  nic.rxErrors + nic.txErrors > 0
                    ? `${formatCount(nic.rxErrors + nic.txErrors)} errors`
                    : null,
                  nic.rxDropped + nic.txDropped > 0
                    ? `${formatCount(nic.rxDropped + nic.txDropped)} dropped`
                    : null,
                ]}
              />
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/**
 * Disks, with the filesystems that live on them.
 *
 * A mount point and the drive underneath it are one subject. Listed apart, a
 * reader had to match `/dev/nvme1n1p2` to `nvme1n1` themselves to learn which
 * drive was filling up, or which one was the hot one.
 */
export function Storage({
  devices,
  filesystems,
  sensors,
}: {
  devices: readonly BlockDevice[];
  filesystems: readonly DiskInfo[];
  sensors: readonly SensorReading[];
}) {
  const groups = devices.map((device) => ({
    device,
    mounts: filesystems.filter((disk) => partitionOf(disk.device) === device.name),
  }));

  const orphans = filesystems.filter(
    (disk) => !devices.some((device) => partitionOf(disk.device) === device.name),
  );

  return (
    <Card title="Storage">
      <ul className="mt-3 flex flex-col gap-4">
        {groups.map(({ device, mounts }) => (
          <li key={device.name}>
            <div className="flex items-baseline justify-between gap-3">
              <span className="truncate font-mono text-sm">
                {device.name}
                {device.model && <span className="text-muted-foreground"> · {device.model}</span>}
              </span>
              <span className="flex shrink-0 items-baseline gap-3">
                <Temperature summary={deviceSensors(sensors, device.name)} />
                <span className="font-mono text-sm tabular">{formatBytes(device.sizeBytes)}</span>
              </span>
            </div>

            <Facts
              items={[
                device.rotational === null ? null : device.rotational ? 'spinning' : 'solid state',
                device.linkSpeed === null
                  ? null
                  : `${device.linkSpeed}${device.linkWidth ? ` ×${device.linkWidth}` : ''}`,
                `read ${formatBytesPerSecond(device.readBytesPerSecond)}`,
                `write ${formatBytesPerSecond(device.writeBytesPerSecond)}`,
              ]}
            />

            {mounts.map((mount) => (
              <Mount key={mount.mount} mount={mount} />
            ))}
          </li>
        ))}

        {orphans.map((mount) => (
          <li key={mount.mount}>
            <Mount mount={mount} />
          </li>
        ))}
      </ul>
    </Card>
  );
}

function Mount({ mount }: { mount: DiskInfo }) {
  const percent = mount.totalBytes > 0 ? (mount.usedBytes / mount.totalBytes) * 100 : null;

  return (
    <div className="mt-2 pl-3">
      <div className="flex items-baseline justify-between gap-3">
        <span className="truncate font-mono text-xs">
          {mount.mount}
          {mount.fsType && <span className="text-muted-foreground"> · {mount.fsType}</span>}
        </span>
        <span className="shrink-0 font-mono text-xs tabular">
          {formatOfTotal(mount.usedBytes, mount.totalBytes)}
          <span className="ml-2 text-muted-foreground">{formatPercent(percent, 0)}</span>
        </span>
      </div>
      <Bar percent={percent} />
    </div>
  );
}

/** `/dev/nvme1n1p2` belongs to `nvme1n1`; `/dev/sda1` belongs to `sda`. */
export function partitionOf(devicePath: string): string {
  const name = devicePath.replace(/^\/dev\//, '');
  return /^nvme\d+n\d+p\d+$/.test(name) ? name.replace(/p\d+$/, '') : name.replace(/\d+$/, '');
}

export function Graphics({ gpus }: { gpus: readonly GpuInfo[] }) {
  return (
    <Card title="Graphics">
      <ul className="mt-2 flex flex-col gap-3">
        {gpus.map((gpu) => (
          <li key={gpu.card}>
            <div className="flex items-baseline justify-between gap-3">
              <span className="truncate font-mono text-sm">
                {[gpu.vendor, gpu.driver].filter(Boolean).join(' ') || gpu.card}
              </span>
              <span className="shrink-0 font-mono text-sm tabular">
                {formatMhz(gpu.mhzCur)}
                <span className="text-muted-foreground"> / {formatMhz(gpu.mhzMax)}</span>
              </span>
            </div>
            <Bar
              percent={gpu.mhzCur !== null && gpu.mhzMax ? (gpu.mhzCur / gpu.mhzMax) * 100 : null}
            />
            <Facts
              items={[
                gpu.pciId,
                gpu.linkSpeed === null
                  ? null
                  : `${gpu.linkSpeed}${gpu.linkWidth ? ` ×${gpu.linkWidth}` : ''}`,
                gpu.memShared
                  ? // Not a driver that failed to answer: an integrated GPU has
                    // no memory of its own, and a blank would read as a gap.
                    'memory shared with system RAM'
                  : `VRAM ${formatOfTotal(gpu.memUsedBytes, gpu.memTotalBytes)}`,
                gpu.memMhzCur === null ? null : `memory ${formatMhz(gpu.memMhzCur)}`,
                gpu.busyPercent === null ? null : `${formatPercent(gpu.busyPercent, 0)} busy`,
              ]}
            />
          </li>
        ))}
      </ul>
    </Card>
  );
}

/** Sensors belonging to no section above — one line, not a heading. */
export function OtherSensors({
  sensors,
  blockDevices,
}: {
  sensors: readonly SensorReading[];
  blockDevices: readonly string[];
}) {
  const loose = looseSensors(sensors, blockDevices);
  if (loose.length === 0) return null;

  return (
    <p className="flex flex-wrap gap-x-4 gap-y-1 px-1 font-mono text-xs text-muted-foreground">
      {loose.map((reading) => (
        <span key={`${reading.chip}.${reading.label}`}>
          {reading.chip} <span className="tabular">{formatCelsius(reading.celsius)}</span>
        </span>
      ))}
    </p>
  );
}

/** Link speed is quoted in gigabits once there is a whole one. */
export function formatLinkSpeed(mbps: number): string {
  return mbps >= 1000 ? `${mbps / 1000} Gb/s` : `${mbps} Mb/s`;
}
