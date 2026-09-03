'use client';

import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Age } from '@/components/age';
import { Series } from '@/components/series';
import { StatTile } from '@/components/stat-tile';
import { Button } from '@/components/ui/button';
import { api, type RatePoint, type SeriesPoint } from '@/lib/api';
import { formatBytes, formatBytesPerSecond, formatCpu, formatPercent } from '@/lib/format';
import { useLiveMetrics, useNow } from '@/lib/live';

const WINDOWS = [
  { minutes: 60, label: '1h' },
  { minutes: 360, label: '6h' },
  { minutes: 1440, label: '24h' },
] as const;

export default function NodeDetailPage() {
  const params = useParams<{ name: string }>();
  const name = decodeURIComponent(params.name);

  const live = useLiveMetrics();
  const now = useNow();
  const [minutes, setMinutes] = useState<number>(60);
  const [points, setPoints] = useState<SeriesPoint[]>([]);
  const [rates, setRates] = useState<RatePoint[]>([]);

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

  const current = live.nodes.find((node) => node.node === name);

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <Button asChild variant="ghost" size="sm">
          <Link href="/nodes">
            <ArrowLeft className="size-4" />
            Nodes
          </Link>
        </Button>
        <h1 className="text-lg font-semibold tracking-tight">{name}</h1>
        <Age sampledAt={current?.sampledAt ?? null} now={now} />

        <div className="ml-auto flex gap-1">
          {WINDOWS.map((window) => (
            <Button
              key={window.minutes}
              variant={minutes === window.minutes ? 'secondary' : 'ghost'}
              size="sm"
              onClick={() => setMinutes(window.minutes)}
            >
              {window.label}
            </Button>
          ))}
        </div>
      </div>

      <div className="grid shrink-0 grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile
          label="CPU"
          value={formatCpu(current?.cpuMilli ?? null)}
          detail={formatPercent(current?.cpuPercent ?? null)}
        />
        <StatTile
          label="Memory"
          value={formatBytes(current?.memoryBytes ?? null)}
          detail={formatPercent(current?.memoryPercent ?? null)}
        />
        <StatTile
          label="Disk"
          value={formatPercent(current?.fsPercent ?? null)}
          detail={formatBytes(current?.fsUsedBytes ?? null)}
        />
        <StatTile
          label="Network"
          value={formatBytesPerSecond(current?.netRxBytesPerSecond ?? null)}
          detail={`sent ${formatBytesPerSecond(current?.netTxBytesPerSecond ?? null)}`}
        />
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 overflow-y-auto lg:grid-cols-2">
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
    </div>
  );
}
