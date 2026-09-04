'use client';

import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Age } from '@/components/age';
import { Graphics, Memory, Network, OtherSensors, Processor, Storage } from '@/components/machine';
import { Series } from '@/components/series';
import { DEFAULT_RANGE_MINUTES, TimeRange } from '@/components/time-range';
import { Button } from '@/components/ui/button';
import type { DiskInfo, HostResourcesRow, RatePoint, SeriesPoint } from '@/lib/api';
import { api } from '@/lib/api';
import { formatBytes, formatBytesPerSecond, formatPercent } from '@/lib/format';
import { useLiveMetrics, useNow } from '@/lib/live';

/**
 * Everything about one machine, grouped by the part it describes.
 *
 * There is no separate hardware screen and no separate temperature list: what a
 * processor is doing, what it is, and how hot it is are one subject, and so are
 * a disk, its filesystems and its sensor. Splitting them made a reader hold two
 * places on the page to answer one question about one part.
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
        // No agent, or the facet is not enabled. The screen says so at the
        // bottom rather than showing empty hardware panels.
        if (!cancelled) setResources(null);
      }
    };

    void load();
    // Sensors move faster than a machine's shape but far slower than the
    // figures the socket carries.
    const timer = setInterval(() => void load(), 15_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [name]);

  const current = live.nodes.find((node) => node.node === name);
  const host = current?.host;

  // The agent measures CPU from /proc/stat once a second; the kubelet reports
  // millicores against a declared capacity every five. Prefer the former, and
  // date the page by whichever reading it actually shows.
  const cpuPercent = host?.cpuPercent ?? current?.cpuPercent ?? null;
  const sampledAt = host?.sampledAt ?? current?.sampledAt ?? null;

  const sensors = resources?.sensors ?? [];
  const blockDevices = resources?.block_devices ?? [];
  const filesystems = mountedFilesystems(resources?.disks ?? [], current ?? null);

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

      {/* One scroll region: the figures and the history they belong to move together. */}
      <div className="pane flex flex-col gap-3 pr-1">
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          <Processor
            cpu={resources?.cpu ?? null}
            percent={cpuPercent}
            clockMhz={host?.cpuMhzAverage ?? null}
            clockMaxMhz={host?.cpuMhzMax ?? null}
            loadPercent={loadShare(host?.load1 ?? null, resources?.cpu_cores ?? null)}
            sensors={sensors}
          />

          <Memory
            usedBytes={host?.memUsedBytes ?? current?.memoryBytes ?? null}
            totalBytes={host?.memTotalBytes ?? current?.capacityMemoryBytes ?? null}
            percent={(host ? host.memPercent : current?.memoryPercent) ?? null}
            availableBytes={host?.memAvailableBytes ?? null}
            swapUsedBytes={host?.swapUsedBytes ?? null}
            swapTotalBytes={host?.swapTotalBytes ?? null}
            modules={resources?.memory_modules ?? []}
            slots={resources?.memory_slots ?? null}
          />
        </div>

        <Network
          rxBytesPerSecond={host?.netRxBytesPerSecond ?? current?.netRxBytesPerSecond ?? null}
          txBytesPerSecond={host?.netTxBytesPerSecond ?? current?.netTxBytesPerSecond ?? null}
          nics={resources?.nics ?? []}
        />

        {(blockDevices.length > 0 || filesystems.length > 0) && (
          <Storage devices={blockDevices} filesystems={filesystems} sensors={sensors} />
        )}

        {(resources?.gpus.length ?? 0) > 0 && <Graphics gpus={resources?.gpus ?? []} />}

        <OtherSensors sensors={sensors} blockDevices={blockDevices.map((device) => device.name)} />

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
            Clocks, host memory, disks, interfaces and sensors come from the optional agent, which
            is not reporting for this node.
          </p>
        )}
      </div>
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
function mountedFilesystems(
  disks: readonly DiskInfo[],
  current: { fsUsedBytes: number | null; fsCapacityBytes: number | null } | null,
): DiskInfo[] {
  if (disks.length > 0) return [...disks];

  if (current?.fsUsedBytes == null || current.fsCapacityBytes == null) return [];
  return [
    {
      mount: 'kubelet root filesystem',
      device: '',
      fsType: '',
      totalBytes: current.fsCapacityBytes,
      usedBytes: current.fsUsedBytes,
    },
  ];
}

/**
 * Load as a share of the machine.
 *
 * A load of 0.20 means nothing without the thread count beside it, and putting
 * both on screen asks the reader to divide. This does the division.
 */
function loadShare(load1: number | null, threads: number | null): number | null {
  if (load1 === null || !threads) return null;
  return (load1 / threads) * 100;
}

function cpuPercentOf(point: SeriesPoint, capacityMilli: number | null): number | null {
  if (point.cpuMilli === null || !capacityMilli) return null;
  return (point.cpuMilli / capacityMilli) * 100;
}
