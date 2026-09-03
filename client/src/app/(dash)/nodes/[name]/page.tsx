'use client';

import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Age } from '@/components/age';
import { Bar, ResourceCard } from '@/components/resource-card';
import { Series } from '@/components/series';
import { Temperatures } from '@/components/temperatures';
import { DEFAULT_RANGE_MINUTES, TimeRange } from '@/components/time-range';
import { Button } from '@/components/ui/button';
import type { DiskInfo, GpuInfo, HostResourcesRow, RatePoint, SeriesPoint } from '@/lib/api';
import { api } from '@/lib/api';
import {
  formatBytes,
  formatBytesPerSecond,
  formatMhz,
  formatOfTotal,
  formatPercent,
} from '@/lib/format';
import { useLiveMetrics, useNow } from '@/lib/live';

/**
 * Everything about one machine.
 *
 * There is no separate hardware screen: clocks, sensors, GPUs and filesystems
 * describe this node, and splitting them across two pages made a reader hold
 * both in their head to answer one question. The agent deepens this screen
 * rather than adding another.
 */
export default function NodeDetailPage() {
  const params = useParams<{ name: string }>();
  const name = decodeURIComponent(params.name);

  const live = useLiveMetrics();
  const now = useNow();
  const [minutes, setMinutes] = useState<number>(DEFAULT_RANGE_MINUTES);
  const [points, setPoints] = useState<SeriesPoint[]>([]);
  const [rates, setRates] = useState<RatePoint[]>([]);
  const [resources, setResources] = useState<HostResourcesRow | null>(null);
  const [temps, setTemps] = useState<Record<string, number>>({});

  useEffect(() => {
    let cancelled = false;

    const load = async (): Promise<void> => {
      const series = await api.series(name, minutes);
      if (!cancelled) {
        setPoints(series.points);
        setRates(series.rates);
      }
    };

    void load();
    // History moves far more slowly than the live figures above it.
    const timer = setInterval(() => void load(), 30_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [name, minutes]);

  useEffect(() => {
    let cancelled = false;

    const load = async (): Promise<void> => {
      const [snapshot, sensors] = await Promise.allSettled([
        api.hostResources(name),
        api.facet('hardware', new URLSearchParams({ node: name, limit: '1' })),
      ]);
      if (cancelled) return;

      setResources(snapshot.status === 'fulfilled' ? (snapshot.value.rows[0] ?? null) : null);
      setTemps(
        sensors.status === 'fulfilled'
          ? ((sensors.value.rows[0] as { temps?: Record<string, number> })?.temps ?? {})
          : {},
      );
    };

    void load();
    // The shape of a machine changes on an administrator's timescale; sensors
    // move faster than that but far slower than the figures above.
    const timer = setInterval(() => void load(), 15_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [name]);

  const current = live.nodes.find((node) => node.node === name);
  const host = current?.host;
  const gpus = resources?.gpus ?? [];

  // The agent measures CPU from /proc/stat once a second; the kubelet reports
  // millicores against a declared capacity every five. Prefer the former, and
  // date the page by whichever reading it actually shows.
  const cpuPercent = host?.cpuPercent ?? current?.cpuPercent ?? null;
  const sampledAt = host?.sampledAt ?? current?.sampledAt ?? null;

  const disks = diskRows(resources?.disks ?? [], current ?? null);

  return (
    <div className="screen gap-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Button asChild variant="ghost" size="sm">
          <Link href="/nodes">
            <ArrowLeft className="size-4" />
            Nodes
          </Link>
        </Button>
        <h1 className="text-lg font-semibold tracking-tight">{name}</h1>
        <Age sampledAt={sampledAt} now={now} />
        <div className="ml-auto">
          <TimeRange minutes={minutes} onChange={setMinutes} />
        </div>
      </div>

      {resources?.cpu_model && (
        <p className="font-mono text-xs text-muted-foreground">
          {resources.cpu_model}
          {resources.cpu_cores !== null && ` · ${resources.cpu_cores} threads`}
        </p>
      )}

      {/* One scroll region: the figures and the history they belong to move together. */}
      <div className="pane flex flex-col gap-3 pr-1">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-5">
          <ResourceCard
            className="md:col-span-2"
            label="CPU"
            headline={formatPercent(cpuPercent)}
            percent={cpuPercent}
            detail={cpuDetail(host, resources)}
          />

          <ResourceCard
            className="md:col-span-3"
            label="Memory"
            headline={
              host
                ? formatOfTotal(host.memUsedBytes, host.memTotalBytes)
                : formatOfTotal(current?.memoryBytes ?? null, current?.capacityMemoryBytes ?? null)
            }
            percent={(host ? host.memPercent : current?.memoryPercent) ?? null}
            detail={memoryDetail(host)}
          />
        </div>

        <section className="rounded-lg border border-line bg-card px-4 py-3">
          <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
            Network
          </p>
          <div className="mt-1 flex flex-wrap items-baseline gap-x-6 gap-y-1">
            <span className="font-mono text-xl font-medium tabular">
              ↓ {formatBytesPerSecond(current?.netRxBytesPerSecond ?? null)}
            </span>
            <span className="font-mono text-xl font-medium tabular">
              ↑ {formatBytesPerSecond(current?.netTxBytesPerSecond ?? null)}
            </span>
            <span className="text-xs text-muted-foreground">summed across physical interfaces</span>
          </div>
        </section>

        {disks.length > 0 && (
          <section className="rounded-lg border border-line bg-card px-4 py-3">
            <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
              Storage
            </p>
            <ul className="mt-3 flex flex-col gap-3">
              {disks.map((disk) => (
                <li key={disk.mount}>
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="truncate font-mono text-sm">{disk.mount}</span>
                    <span className="shrink-0 font-mono text-sm tabular">
                      {formatOfTotal(disk.usedBytes, disk.totalBytes)}
                      <span className="ml-2 text-xs text-muted-foreground">
                        {formatPercent(percentOf(disk.usedBytes, disk.totalBytes), 0)}
                      </span>
                    </span>
                  </div>
                  <Bar percent={percentOf(disk.usedBytes, disk.totalBytes)} />
                  <p className="mt-1 font-mono text-[11px] text-muted-foreground">
                    {disk.device}
                    {disk.fsType && ` · ${disk.fsType}`}
                  </p>
                </li>
              ))}
            </ul>
          </section>
        )}

        {(gpus.length > 0 || Object.keys(temps).length > 0) && (
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            {gpus.length > 0 && (
              <section className="rounded-lg border border-line bg-card px-4 py-3">
                <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
                  Graphics
                </p>
                <ul className="mt-3 flex flex-col gap-4">
                  {gpus.map((gpu) => (
                    <Gpu key={gpu.card} gpu={gpu} />
                  ))}
                </ul>
              </section>
            )}

            {Object.keys(temps).length > 0 && (
              <section className="rounded-lg border border-line bg-card px-4 py-3">
                <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
                  Temperatures
                </p>
                <div className="mt-3">
                  <Temperatures temps={temps} />
                </div>
              </section>
            )}
          </div>
        )}

        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          <Series
            title="CPU"
            points={points.map((point) => ({
              at: point.at,
              value: cpuPercentOf(point, current?.capacityCpuMilli ?? null),
            }))}
            format={(value) => formatPercent(value)}
          />
          <Series
            title="Memory"
            points={points.map((point) => ({ at: point.at, value: point.memoryBytes }))}
            format={(value) => formatBytes(value)}
          />
          <Series
            title="Received"
            points={rates.map((point) => ({ at: point.at, value: point.netRxBytesPerSecond }))}
            format={(value) => formatBytesPerSecond(value)}
          />
          <Series
            title="Transmitted"
            points={rates.map((point) => ({ at: point.at, value: point.netTxBytesPerSecond }))}
            format={(value) => formatBytesPerSecond(value)}
          />
        </div>

        {!host && (
          <p className="pb-1 text-xs text-muted-foreground">
            Clocks, host memory, GPUs, filesystems and sensors come from the optional agent, which
            is not reporting for this node.
          </p>
        )}
      </div>
    </div>
  );
}

function Gpu({ gpu }: { gpu: GpuInfo }) {
  return (
    <li>
      <div className="flex items-baseline justify-between gap-3">
        <span className="font-mono text-xs text-muted-foreground">
          {gpu.driver ?? gpu.card}
          {gpu.pciId && ` · ${gpu.pciId}`}
        </span>
        {gpu.busyPercent !== null && (
          <span className="font-mono text-xs tabular">
            {formatPercent(gpu.busyPercent, 0)} busy
          </span>
        )}
      </div>

      <Clock label="Core" current={gpu.mhzCur} ceiling={gpu.mhzMax} />
      {(gpu.memMhzCur !== null || gpu.memMhzMax !== null) && (
        <Clock label="Memory" current={gpu.memMhzCur} ceiling={gpu.memMhzMax} />
      )}

      <p className="mt-1.5 text-xs text-muted-foreground">
        {gpu.memShared
          ? // Not a driver that failed to answer: an integrated GPU has no
            // memory of its own, and a blank here would read as a gap.
            'Memory shared with system RAM'
          : `VRAM ${formatOfTotal(gpu.memUsedBytes, gpu.memTotalBytes)}`}
      </p>
    </li>
  );
}

function Clock({
  label,
  current,
  ceiling,
}: {
  label: string;
  current: number | null;
  ceiling: number | null;
}) {
  return (
    <div className="mt-2">
      <div className="flex items-baseline justify-between gap-3">
        <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
          {label}
        </span>
        <span className="font-mono text-sm tabular">
          {formatMhz(current)}
          <span className="text-muted-foreground"> / {formatMhz(ceiling)}</span>
        </span>
      </div>
      <Bar percent={current !== null && ceiling ? (current / ceiling) * 100 : null} />
    </div>
  );
}

/**
 * Every filesystem, or the kubelet's one.
 *
 * The agent sees what the machine actually mounts; without it the kubelet knows
 * only the filesystem its own root lives on, and calling that "the disk" on a
 * machine with four of them would be a guess presented as a fact.
 */
function diskRows(
  disks: readonly DiskInfo[],
  current: { fsUsedBytes: number | null; fsCapacityBytes: number | null } | null,
): DiskInfo[] {
  if (disks.length > 0) return [...disks];

  if (current?.fsUsedBytes == null || current.fsCapacityBytes == null) return [];
  return [
    {
      mount: 'kubelet root filesystem',
      device: 'reported by the kubelet',
      fsType: '',
      totalBytes: current.fsCapacityBytes,
      usedBytes: current.fsUsedBytes,
    },
  ];
}

function cpuDetail(
  host:
    | { cpuMhzAverage: number | null; cpuMhzMax: number | null; load1: number | null }
    | undefined,
  resources: HostResourcesRow | null,
): string {
  if (!host) return 'container usage against node capacity';

  const parts = [`${formatMhz(host.cpuMhzAverage)} of ${formatMhz(host.cpuMhzMax)}`];

  // Load is threads-worth-of-work, which only means something against how many
  // threads exist. Stated as a share of the machine it needs no arithmetic.
  const cores = resources?.cpu_cores ?? null;
  if (host.load1 !== null && cores) {
    parts.push(`load ${formatPercent((host.load1 / cores) * 100, 0)}`);
  }

  return parts.join(' · ');
}

function memoryDetail(
  host:
    | {
        memAvailableBytes: number | null;
        swapTotalBytes: number | null;
        swapUsedBytes: number | null;
      }
    | undefined,
): string {
  if (!host) return 'container working set against node capacity';

  const parts = [`${formatBytes(host.memAvailableBytes)} available`];
  if (host.swapTotalBytes) {
    parts.push(`swap ${formatOfTotal(host.swapUsedBytes, host.swapTotalBytes)}`);
  }
  return parts.join(' · ');
}

function cpuPercentOf(point: SeriesPoint, capacityMilli: number | null): number | null {
  if (point.cpuMilli === null || !capacityMilli) return null;
  return (point.cpuMilli / capacityMilli) * 100;
}

function percentOf(used: number | null, total: number | null): number | null {
  if (used === null || total === null || total <= 0) return null;
  return (used / total) * 100;
}
