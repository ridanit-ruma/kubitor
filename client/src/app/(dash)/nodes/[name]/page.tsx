'use client';

import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Age } from '@/components/age';
import { Bar, ResourceCard } from '@/components/resource-card';
import { Series } from '@/components/series';
import { DEFAULT_RANGE_MINUTES, TimeRange } from '@/components/time-range';
import { Button } from '@/components/ui/button';
import { api, type HostResourcesRow, type RatePoint, type SeriesPoint } from '@/lib/api';
import {
  formatBytes,
  formatBytesPerSecond,
  formatCpu,
  formatMhz,
  formatOfTotal,
  formatPercent,
} from '@/lib/format';
import { useLiveMetrics, useNow } from '@/lib/live';

export default function NodeDetailPage() {
  const params = useParams<{ name: string }>();
  const name = decodeURIComponent(params.name);

  const live = useLiveMetrics();
  const now = useNow();
  const [minutes, setMinutes] = useState<number>(DEFAULT_RANGE_MINUTES);
  const [points, setPoints] = useState<SeriesPoint[]>([]);
  const [rates, setRates] = useState<RatePoint[]>([]);
  const [resources, setResources] = useState<HostResourcesRow | null>(null);

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
      try {
        const page = await api.hostResources(name);
        if (!cancelled) setResources(page.rows[0] ?? null);
      } catch {
        // No agent, or the facet is not enabled. The screen says so below
        // rather than showing empty hardware panels.
        if (!cancelled) setResources(null);
      }
    };

    void load();
    // The shape of a machine changes on an administrator's timescale.
    const timer = setInterval(() => void load(), 60_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [name]);

  const current = live.nodes.find((node) => node.node === name);
  const host = current?.host;
  const gpus = resources?.gpus ?? [];
  const disks = resources?.disks ?? [];

  return (
    <div className="screen gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <Button asChild variant="ghost" size="sm">
          <Link href="/nodes">
            <ArrowLeft className="size-4" />
            Nodes
          </Link>
        </Button>
        <h1 className="text-lg font-semibold tracking-tight">{name}</h1>
        <Age sampledAt={current?.sampledAt ?? null} now={now} />
        <div className="ml-auto">
          <TimeRange minutes={minutes} onChange={setMinutes} />
        </div>
      </div>

      {resources?.cpu_model && (
        <p className="-mt-2 font-mono text-xs text-muted-foreground">
          {resources.cpu_model}
          {resources.cpu_cores !== null && ` · ${resources.cpu_cores} threads`}
        </p>
      )}

      <div className="grid shrink-0 grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <ResourceCard
          label="CPU"
          headline={`${formatCpu(current?.cpuMilli ?? null)} / ${formatCpu(
            current?.capacityCpuMilli ?? null,
          )}`}
          percent={current?.cpuPercent ?? null}
          detail={cpuDetail(host)}
        />

        {/*
          Host RAM when the agent reports it, the kubelet's container working
          set otherwise. They are different measurements, so the card names
          which one it is showing instead of letting the reader assume.
        */}
        <ResourceCard
          label="Memory"
          headline={
            host
              ? formatOfTotal(host.memUsedBytes, host.memTotalBytes)
              : formatOfTotal(current?.memoryBytes ?? null, current?.capacityMemoryBytes ?? null)
          }
          percent={(host ? host.memPercent : current?.memoryPercent) ?? null}
          detail={memoryDetail(host)}
        />

        <ResourceCard
          label="Disk"
          headline={formatOfTotal(current?.fsUsedBytes ?? null, current?.fsCapacityBytes ?? null)}
          percent={current?.fsPercent ?? null}
          detail={
            disks.length > 0
              ? `${disks.length} mounted filesystem${disks.length === 1 ? '' : 's'}`
              : 'kubelet root filesystem'
          }
        />

        <ResourceCard
          label="Network"
          headline={`↓ ${formatBytesPerSecond(current?.netRxBytesPerSecond ?? null)}`}
          detail={`↑ ${formatBytesPerSecond(current?.netTxBytesPerSecond ?? null)} · physical interfaces`}
        />
      </div>

      <div className="pane flex flex-col gap-3">
        {(gpus.length > 0 || disks.length > 0) && (
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            {gpus.length > 0 && (
              <section className="rounded-lg border border-line bg-card p-4">
                <h2 className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
                  Graphics
                </h2>
                <ul className="mt-3 flex flex-col gap-3">
                  {gpus.map((gpu) => (
                    <li key={gpu.card}>
                      <div className="flex items-baseline justify-between gap-3">
                        <span className="font-mono text-xs text-muted-foreground">
                          {gpu.driver ?? gpu.card}
                          {gpu.pciId && ` · ${gpu.pciId}`}
                        </span>
                        <span className="font-mono text-sm tabular">
                          {formatMhz(gpu.mhzCur)}
                          <span className="text-muted-foreground"> / {formatMhz(gpu.mhzMax)}</span>
                        </span>
                      </div>
                      <Bar
                        percent={
                          gpu.mhzCur !== null && gpu.mhzMax ? (gpu.mhzCur / gpu.mhzMax) * 100 : null
                        }
                      />
                      {gpu.memTotalBytes !== null && (
                        <p className="mt-1.5 text-xs text-muted-foreground">
                          VRAM {formatOfTotal(gpu.memUsedBytes, gpu.memTotalBytes)}
                          {gpu.busyPercent !== null &&
                            ` · ${formatPercent(gpu.busyPercent, 0)} busy`}
                        </p>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {disks.length > 0 && (
              <section className="rounded-lg border border-line bg-card p-4">
                <h2 className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
                  Filesystems
                </h2>
                <ul className="mt-3 flex flex-col gap-3">
                  {disks.map((disk) => (
                    <li key={disk.mount}>
                      <div className="flex items-baseline justify-between gap-3">
                        <span className="truncate font-mono text-xs">{disk.mount}</span>
                        <span className="shrink-0 font-mono text-sm tabular">
                          {formatOfTotal(disk.usedBytes, disk.totalBytes)}
                        </span>
                      </div>
                      <Bar
                        percent={
                          disk.totalBytes > 0 ? (disk.usedBytes / disk.totalBytes) * 100 : null
                        }
                      />
                      <p className="mt-1.5 font-mono text-[11px] text-muted-foreground">
                        {disk.device} · {disk.fsType}
                      </p>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>
        )}

        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          <Series
            title="CPU"
            points={points.map((point) => ({ at: point.at, value: point.cpuMilli }))}
            format={(value) => formatCpu(value)}
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
            Clocks, host RAM, GPUs and filesystems come from the optional agent, which is not
            reporting for this node.
          </p>
        )}
      </div>
    </div>
  );
}

function cpuDetail(
  host:
    | { cpuMhzAverage: number | null; cpuMhzMax: number | null; load1: number | null }
    | undefined,
): string {
  if (!host) return 'container usage against node capacity';

  const parts = [`${formatMhz(host.cpuMhzAverage)} of ${formatMhz(host.cpuMhzMax)}`];
  if (host.load1 !== null) parts.push(`load ${host.load1.toFixed(2)}`);
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
