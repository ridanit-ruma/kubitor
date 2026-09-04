import type { BlockDevice, CpuDetail, MemoryModule, NicInfo } from '@/lib/api';
import { formatBytes, formatBytesPerSecond, formatCount } from '@/lib/format';

/**
 * What a machine is, as opposed to what it is doing.
 *
 * The figures above this on the node screen change every second; none of this
 * changes while the machine is running. It is here because "how much memory can
 * I still add" and "is that NVMe on four lanes or one" are questions about a
 * node, and until now they were answered by logging in.
 */

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-line bg-card px-4 py-3">
      <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
        {title}
      </p>
      {children}
    </section>
  );
}

/** A run of short facts, separated rather than each given its own row. */
function Facts({ items }: { items: readonly (string | null)[] }) {
  const usable = items.filter((item): item is string => item !== null && item !== '');
  if (usable.length === 0) return null;

  return <p className="mt-1 font-mono text-xs text-muted-foreground">{usable.join(' · ')}</p>;
}

export function Processor({ cpu }: { cpu: CpuDetail }) {
  return (
    <Section title="Processor">
      <p className="mt-1 text-sm">{cpu.model ?? 'Unknown model'}</p>

      <Facts
        items={[
          cpu.sockets === null ? null : `${cpu.sockets} socket${cpu.sockets === 1 ? '' : 's'}`,
          cpu.coresPerSocket === null ? null : `${cpu.coresPerSocket} cores each`,
          cpu.threads === null ? null : `${cpu.threads} threads`,
          cpu.vendor,
        ]}
      />

      <Facts
        items={[
          cpu.family === null ? null : `family ${cpu.family}`,
          cpu.modelNumber === null ? null : `model ${cpu.modelNumber}`,
          cpu.stepping === null ? null : `stepping ${cpu.stepping}`,
          cpu.microcode === null ? null : `microcode ${cpu.microcode}`,
          cpu.governor === null ? null : `${cpu.governor} governor`,
        ]}
      />

      {cpu.caches.length > 0 && (
        <Facts
          items={cpu.caches.map((cache) => `${cacheName(cache)} ${formatBytes(cache.sizeBytes)}`)}
        />
      )}

      {cpu.features.length > 0 && (
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
    </Section>
  );
}

/** `L1d`, `L1i`, `L2` — the names a person uses, not `L1 Data`. */
function cacheName(cache: { level: number; type: string }): string {
  const suffix = { Data: 'd', Instruction: 'i', Unified: '' }[cache.type] ?? '';
  return `L${cache.level}${suffix}`;
}

export function Memory({
  modules,
  totalBytes,
}: {
  modules: readonly MemoryModule[];
  totalBytes: number | null;
}) {
  const kinds = [...new Set(modules.map((module) => module.type).filter(Boolean))];

  return (
    <Section title="Memory">
      <p className="mt-1 text-sm">
        {formatBytes(totalBytes)}
        <span className="text-muted-foreground">
          {' '}
          across {modules.length} module{modules.length === 1 ? '' : 's'}
        </span>
      </p>
      <Facts items={kinds} />

      <ul className="mt-3 flex flex-col gap-1">
        {modules.map((module) => (
          <li
            key={module.slot}
            className="flex items-baseline justify-between gap-4 font-mono text-xs"
          >
            <span className="truncate text-muted-foreground">{module.slot}</span>
            <span className="shrink-0 tabular">
              {formatBytes(module.sizeBytes)}
              {module.width && <span className="ml-2 text-muted-foreground">{module.width}</span>}
            </span>
          </li>
        ))}
      </ul>
    </Section>
  );
}

export function Disks({ devices }: { devices: readonly BlockDevice[] }) {
  return (
    <Section title="Disks">
      <ul className="mt-3 flex flex-col gap-3">
        {devices.map((device) => (
          <li key={device.name}>
            <div className="flex items-baseline justify-between gap-3">
              <span className="truncate font-mono text-sm">
                {device.name}
                {device.model && <span className="text-muted-foreground"> · {device.model}</span>}
              </span>
              <span className="shrink-0 font-mono text-sm tabular">
                {formatBytes(device.sizeBytes)}
              </span>
            </div>

            <Facts
              items={[
                device.rotational === null ? null : device.rotational ? 'spinning' : 'solid state',
                device.linkSpeed === null
                  ? null
                  : `${device.linkSpeed}${device.linkWidth ? ` ×${device.linkWidth}` : ''}`,
                device.schedulerQueue === null ? null : `${device.schedulerQueue} scheduler`,
              ]}
            />

            <p className="mt-1 font-mono text-xs tabular">
              read {formatBytesPerSecond(device.readBytesPerSecond)}
              <span className="text-muted-foreground"> · </span>
              write {formatBytesPerSecond(device.writeBytesPerSecond)}
              {device.readsPerSecond !== null && device.writesPerSecond !== null && (
                <span className="text-muted-foreground">
                  {' '}
                  · {formatCount(Math.round(device.readsPerSecond + device.writesPerSecond))} IOPS
                </span>
              )}
            </p>
          </li>
        ))}
      </ul>
    </Section>
  );
}

export function Interfaces({ nics }: { nics: readonly NicInfo[] }) {
  return (
    <Section title="Network interfaces">
      <ul className="mt-3 flex flex-col gap-3">
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
                nic.macAddress,
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
    </Section>
  );
}

/** Link speed is quoted in gigabits once there is a whole one. */
export function formatLinkSpeed(mbps: number): string {
  return mbps >= 1000 ? `${mbps / 1000} Gb/s` : `${mbps} Mb/s`;
}
