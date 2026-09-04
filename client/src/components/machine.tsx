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

interface Spec {
  label: string;
  value: string;
  /** A secondary figure that belongs to the same fact — a range, a ceiling. */
  hint?: string | undefined;
}

/**
 * Facts as a labelled grid rather than a run-on line.
 *
 * Joining them with separators reads fine until it wraps, and on a phone it
 * always wraps — mid-fact, so "8.0 GT/s" ends one line and "PCIe ×4" starts the
 * next. A grid breaks between facts instead of inside them, keeps the labels in
 * a column the eye can run down, and stays two facts wide where a plain list
 * would be one.
 */
function Specs({ items }: { items: readonly (Spec | null | undefined)[] }) {
  const usable = items.filter((item): item is Spec => !!item);
  if (usable.length === 0) return null;

  return (
    <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
      {usable.map((item) => (
        <div key={item.label} className="min-w-0">
          <dt className="truncate font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
            {item.label}
          </dt>
          <dd className="truncate font-mono text-xs tabular">
            {item.value}
            {item.hint && <span className="ml-1.5 text-muted-foreground">{item.hint}</span>}
          </dd>
        </div>
      ))}
    </dl>
  );
}

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
  const cache = (level: string): Spec | null => {
    const found = cpu?.caches.find((entry) => cacheName(entry) === level);
    return found ? { label: level, value: formatBytes(found.sizeBytes, 0) } : null;
  };

  return (
    <Card title="Processor" right={<Temperature summary={cpuSensors(sensors)} />}>
      <p className="mt-1 font-mono text-2xl font-medium tabular">{formatPercent(percent)}</p>
      <Bar percent={percent} />

      {cpu?.model && <p className="mt-2 truncate text-sm">{cpu.model}</p>}

      <Specs
        items={[
          cpu?.coresPerSocket
            ? {
                label: 'Cores',
                value: `${cpu.sockets && cpu.sockets > 1 ? `${cpu.sockets} × ` : ''}${cpu.coresPerSocket}`,
                hint: cpu.threads ? `${cpu.threads}T` : undefined,
              }
            : null,
          clockMhz === null
            ? null
            : { label: 'Clock', value: formatMhz(clockMhz), hint: `of ${formatMhz(clockMaxMhz)}` },
          loadPercent === null ? null : { label: 'Load', value: formatPercent(loadPercent, 0) },
          cpu?.governor ? { label: 'Governor', value: cpu.governor } : null,
          cache('L1d'),
          cache('L1i'),
          cache('L2'),
          cache('L3'),
        ]}
      />

      {cpu && cpu.features.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
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
  const summary = summarizeMemory(modules, slots);

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

      <Specs
        items={[
          availableBytes === null
            ? null
            : { label: 'Available', value: formatBytes(availableBytes) },
          summary ? { label: 'Type', value: summary.type } : null,
          summary ? { label: 'Modules', value: summary.modules } : null,
          summary?.slots ? { label: 'Slots', value: summary.slots } : null,
          swapTotalBytes
            ? { label: 'Swap', value: formatOfTotal(swapUsedBytes, swapTotalBytes) }
            : null,
        ]}
      />
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
            <li key={nic.name} className="flex flex-wrap items-baseline justify-between gap-x-4">
              <span className="truncate font-mono text-sm">{nic.name}</span>
              <span className="shrink-0 font-mono text-xs tabular">
                ↓ {formatBytesPerSecond(nic.rxBytesPerSecond)}
                <span className="text-muted-foreground"> · </span>↑{' '}
                {formatBytesPerSecond(nic.txBytesPerSecond)}
              </span>
              <span className="w-full font-mono text-[11px] text-muted-foreground">
                {[
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
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
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
  const orphans = filesystems.filter(
    (disk) => !devices.some((device) => partitionOf(disk.device) === device.name),
  );

  return (
    <Card title="Storage">
      <ul className="mt-2 flex flex-col gap-5">
        {devices.map((device) => {
          const temperature = deviceSensors(sensors, device.name);

          return (
            <li key={device.name}>
              <div className="flex items-baseline justify-between gap-3">
                <span className="truncate font-mono text-sm">{device.name}</span>
                <span className="shrink-0 font-mono text-sm tabular">
                  {formatBytes(device.sizeBytes)}
                </span>
              </div>

              {/* Its own line: sharing one with the size and the temperature
                  left a model number showing as a single letter. */}
              {device.model && (
                <p className="truncate text-xs text-muted-foreground">{device.model}</p>
              )}

              <Specs
                items={[
                  temperature
                    ? {
                        label: 'Temp',
                        value: formatCelsius(temperature.celsius),
                        hint:
                          temperature.count > 1
                            ? `${formatCelsius(temperature.lowest)}–${formatCelsius(temperature.highest)}`
                            : undefined,
                      }
                    : null,
                  device.linkSpeed
                    ? {
                        label: 'Link',
                        value: device.linkSpeed,
                        hint: device.linkWidth ? `×${device.linkWidth}` : undefined,
                      }
                    : null,
                  { label: 'Read', value: formatBytesPerSecond(device.readBytesPerSecond) },
                  { label: 'Write', value: formatBytesPerSecond(device.writeBytesPerSecond) },
                ]}
              />

              {filesystems
                .filter((disk) => partitionOf(disk.device) === device.name)
                .map((mount) => (
                  <Mount key={mount.mount} mount={mount} />
                ))}
            </li>
          );
        })}

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
    <div className="mt-3 border-l border-line pl-3">
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
      <ul className="mt-2 flex flex-col gap-4">
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

            <Specs
              items={[
                gpu.pciId ? { label: 'Device', value: gpu.pciId } : null,
                gpu.linkSpeed
                  ? {
                      label: 'Link',
                      value: gpu.linkSpeed,
                      hint: gpu.linkWidth ? `×${gpu.linkWidth}` : undefined,
                    }
                  : null,
                {
                  label: 'Memory',
                  // Not a driver that failed to answer: an integrated GPU has
                  // no memory of its own, and a blank would read as a gap.
                  value: gpu.memShared
                    ? 'shared'
                    : formatOfTotal(gpu.memUsedBytes, gpu.memTotalBytes),
                  hint: gpu.memShared ? 'system RAM' : undefined,
                },
                gpu.memMhzCur === null
                  ? null
                  : { label: 'Mem clock', value: formatMhz(gpu.memMhzCur) },
                gpu.busyPercent === null
                  ? null
                  : { label: 'Busy', value: formatPercent(gpu.busyPercent, 0) },
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
