'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Age } from '@/components/age';
import { Bar } from '@/components/resource-card';
import { api, type HostResourcesRow } from '@/lib/api';
import { formatCelsius, formatMhz, formatOfTotal, formatPercent } from '@/lib/format';
import { useLiveMetrics, useNow } from '@/lib/live';

/**
 * The host screen.
 *
 * Everything here needs a process on the machine: the API server knows a node's
 * declared capacity but not its clock, its sensors, or what its GPU is doing.
 * Values move at the agent's rate — once a second — while the machine's shape
 * is re-read far less often.
 */
export default function HardwarePage() {
  const live = useLiveMetrics();
  const now = useNow();
  const [rows, setRows] = useState<HostResourcesRow[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const load = async (): Promise<void> => {
      try {
        const page = await api.facet('resources', new URLSearchParams({ limit: '100' }));
        if (!cancelled) setRows(page.rows as HostResourcesRow[]);
      } catch {
        if (!cancelled) setRows([]);
      } finally {
        if (!cancelled) setLoaded(true);
      }
    };

    void load();
    const timer = setInterval(() => void load(), 30_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const sorted = [...rows].sort((a, b) => a.node.localeCompare(b.node));

  return (
    <div className="screen gap-3">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Hardware</h1>
        <p className="text-sm text-muted-foreground">
          Reported by the optional agent. A sensor that cannot be read is left out rather than
          reported as zero.
        </p>
      </div>

      <div className="pane">
        {loaded && sorted.length === 0 && (
          <p className="rounded-lg border border-line bg-card p-6 text-sm text-muted-foreground">
            No agent is reporting. Install the DaemonSet to see clocks, host memory, GPUs and
            temperatures.
          </p>
        )}

        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2 2xl:grid-cols-3">
          {sorted.map((row) => {
            const host = live.nodes.find((node) => node.node === row.node)?.host;
            const clock = host?.cpuMhzAverage ?? row.cpu_mhz_avg;
            const clockMax = host?.cpuMhzMax ?? row.cpu_mhz_max;
            const memUsed = host?.memUsedBytes ?? row.mem_used_bytes;
            const memTotal = host?.memTotalBytes ?? row.mem_total_bytes;

            return (
              <section key={row.node} className="rounded-lg border border-line bg-card p-4">
                <div className="flex items-baseline justify-between gap-3">
                  <Link
                    href={`/nodes/${encodeURIComponent(row.node)}`}
                    className="font-medium underline-offset-4 hover:underline"
                  >
                    {row.node}
                  </Link>
                  <Age sampledAt={host?.sampledAt ?? row.observed_at} now={now} />
                </div>

                {row.cpu_model && (
                  <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
                    {row.cpu_model}
                  </p>
                )}

                <dl className="mt-3 flex flex-col gap-3">
                  <Reading
                    label="CPU clock"
                    value={`${formatMhz(clock)} / ${formatMhz(clockMax)}`}
                    percent={clock !== null && clockMax ? (clock / clockMax) * 100 : null}
                    detail={
                      row.load1 === null
                        ? undefined
                        : `load ${row.load1.toFixed(2)} · ${row.cpu_cores ?? '—'} threads`
                    }
                  />

                  <Reading
                    label="Memory"
                    value={formatOfTotal(memUsed, memTotal)}
                    percent={host?.memPercent ?? percentOf(memUsed, memTotal)}
                    detail={
                      row.swap_total_bytes
                        ? `swap ${formatOfTotal(row.swap_used_bytes, row.swap_total_bytes)}`
                        : 'no swap'
                    }
                  />

                  {row.gpus.map((gpu) => (
                    <Reading
                      key={gpu.card}
                      label={`GPU ${gpu.driver ?? gpu.card}`}
                      value={`${formatMhz(gpu.mhzCur)} / ${formatMhz(gpu.mhzMax)}`}
                      percent={
                        gpu.mhzCur !== null && gpu.mhzMax ? (gpu.mhzCur / gpu.mhzMax) * 100 : null
                      }
                      detail={
                        gpu.busyPercent === null
                          ? (gpu.pciId ?? undefined)
                          : `${formatPercent(gpu.busyPercent, 0)} busy`
                      }
                    />
                  ))}
                </dl>

                {row.disks.length > 0 && (
                  <ul className="mt-3 flex flex-col gap-1.5 border-t border-line pt-3">
                    {row.disks.map((disk) => (
                      <li
                        key={disk.mount}
                        className="flex items-baseline justify-between gap-3 font-mono text-[11px]"
                      >
                        <span className="truncate text-muted-foreground">{disk.mount}</span>
                        <span className="shrink-0 tabular">
                          {formatOfTotal(disk.usedBytes, disk.totalBytes)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}

                <Temperatures node={row.node} />
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function Reading({
  label,
  value,
  percent,
  detail,
}: {
  label: string;
  value: string;
  percent: number | null;
  detail?: string;
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <dt className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
          {label}
        </dt>
        <dd className="font-mono text-sm tabular">{value}</dd>
      </div>
      <Bar percent={percent} />
      {detail && <p className="mt-1 text-[11px] text-muted-foreground">{detail}</p>}
    </div>
  );
}

/**
 * Sensor readings for one node, newest first.
 *
 * They live on the event facet rather than the snapshot because a temperature
 * is only interesting next to the ones before it.
 */
function Temperatures({ node }: { node: string }) {
  const [temps, setTemps] = useState<Record<string, number>>({});

  useEffect(() => {
    let cancelled = false;

    const load = async (): Promise<void> => {
      try {
        const page = await api.facet('hardware', new URLSearchParams({ node, limit: '1' }));
        const row = page.rows[0] as { temps?: Record<string, number> } | undefined;
        if (!cancelled) setTemps(row?.temps ?? {});
      } catch {
        if (!cancelled) setTemps({});
      }
    };

    void load();
    const timer = setInterval(() => void load(), 15_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [node]);

  const entries = Object.entries(temps);
  if (entries.length === 0) return null;

  return (
    <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 border-t border-line pt-3">
      {entries
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([label, celsius]) => (
          <span key={label} className="font-mono text-[11px]">
            <span className="text-muted-foreground">{label}</span>{' '}
            <span className="tabular">{formatCelsius(celsius)}</span>
          </span>
        ))}
    </div>
  );
}

function percentOf(used: number | null, total: number | null): number | null {
  if (used === null || total === null || total <= 0) return null;
  return (used / total) * 100;
}
