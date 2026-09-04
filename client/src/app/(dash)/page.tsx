'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Age } from '@/components/age';
import { Series } from '@/components/series';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { ClusterSummary, ClusterTrafficPoint, LiveNodeMetrics } from '@/lib/api';
import { api } from '@/lib/api';
import { withLiveTail } from '@/lib/chart-data';
import {
  formatBytes,
  formatBytesPerSecond,
  formatClockPair,
  formatCount,
  formatPercent,
} from '@/lib/format';
import { useClusterHistory, useLiveMetrics, useNow } from '@/lib/live';
import { useManifest } from '@/lib/manifest-context';
import { cn } from '@/lib/utils';

/**
 * How far back the traffic charts look.
 *
 * Stored history rather than what the page has watched since it opened: a
 * reload used to empty the chart, and a rate with nothing behind it cannot say
 * whether what it shows is normal.
 */
const TRAFFIC_MINUTES = 60;

/**
 * The cluster in one screen: how loaded it is, what is running, what is not.
 *
 * Deliberately not four equal tiles. A count of pods and a percentage of memory
 * are not the same kind of fact and do not deserve the same box; what they
 * share is that an operator reads all of them before deciding whether to look
 * further. The versions of Kubernetes and of each integration used to sit at
 * the top of this page and answered a question nobody opens an overview to ask.
 */
export default function OverviewPage() {
  const { manifest } = useManifest();
  const live = useLiveMetrics();
  const now = useNow();
  const tail = useClusterHistory(live);
  const [summary, setSummary] = useState<ClusterSummary | null>(null);
  const [traffic, setTraffic] = useState<ClusterTrafficPoint[]>([]);

  useEffect(() => {
    let cancelled = false;

    const load = async (): Promise<void> => {
      try {
        const next = await api.overview();
        if (!cancelled) setSummary(next);
      } catch {
        // A failed poll is not worth a banner; the figures simply hold until
        // the next one, and their age is on screen.
      }
    };

    void load();
    // Pod phases move on the kubelet's schedule, not the socket's.
    const timer = setInterval(() => void load(), 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    const load = async (): Promise<void> => {
      try {
        const series = await api.overviewSeries(TRAFFIC_MINUTES);
        if (!cancelled) setTraffic(series.points);
      } catch {
        // The socket keeps the right-hand edge moving either way; the chart
        // simply has less behind it until the next attempt.
      }
    };

    void load();
    // History moves at the rate it is stored, which is far slower than this.
    const timer = setInterval(() => void load(), 30_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const nodes = [...live.nodes].sort((a, b) => a.node.localeCompare(b.node));

  return (
    <div className="screen gap-2.5">
      <div className="flex items-baseline justify-between gap-4">
        <h1 className="text-base font-semibold tracking-tight">Overview</h1>
        <Age sampledAt={freshest(nodes) ?? live.sampledAt} now={now} />
      </div>

      <div className="grid shrink-0 grid-cols-1 gap-2.5 lg:grid-cols-3">
        <Load nodes={nodes} summary={summary} className="lg:col-span-2" />
        <Pods summary={summary} />
      </div>

      {/* Three equal boxes under two unequal ones: the sizes follow what is in
          them, not a grid the page is trying to satisfy. */}
      <div className="grid shrink-0 grid-cols-1 gap-2.5 lg:grid-cols-3">
        <Series
          title="Received"
          height={64}
          points={withLiveTail(
            traffic.map((point) => ({ at: point.at, value: point.rxBytesPerSecond })),
            tail,
            TRAFFIC_MINUTES * 60_000,
            (sample) => sample.rxBytesPerSecond,
          )}
          format={(value) => formatBytesPerSecond(value)}
        />
        <Series
          title="Transmitted"
          height={64}
          points={withLiveTail(
            traffic.map((point) => ({ at: point.at, value: point.txBytesPerSecond })),
            tail,
            TRAFFIC_MINUTES * 60_000,
            (sample) => sample.txBytesPerSecond,
          )}
          format={(value) => formatBytesPerSecond(value)}
        />
        <Attention summary={summary} manifest={manifest} />
      </div>

      <NodeTable nodes={nodes} now={now} />
    </div>
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
    <section className={cn('rounded-lg border border-line bg-card px-3.5 py-2.5', className)}>
      <div className="flex items-baseline justify-between gap-3">
        <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
          {title}
        </p>
        {right}
      </div>
      {children}
    </section>
  );
}

/**
 * How much of the cluster is in use, against how much there is.
 *
 * One line per resource rather than one card each: they answer the same
 * question and reading them together is the whole point. Every figure carries
 * its total, because a bare 12.9 GiB says nothing about pressure.
 */
function Load({
  nodes,
  summary,
  className,
}: {
  nodes: readonly LiveNodeMetrics[];
  summary: ClusterSummary | null;
  className?: string;
}) {
  const cores = summary ? summary.capacity.cpuMilli / 1000 : null;
  const threads = sum(nodes.map((node) => node.host?.cpuCores ?? null));

  const memoryUsed = sum(nodes.map((node) => node.host?.memUsedBytes ?? node.memoryBytes));
  const memoryTotal = sum(
    nodes.map((node) => node.host?.memTotalBytes ?? node.capacityMemoryBytes),
  );

  const diskUsed = sum(nodes.map((node) => node.fsUsedBytes));
  const diskTotal = sum(nodes.map((node) => node.fsCapacityBytes));

  return (
    <Card
      title="Cluster load"
      className={className}
      right={
        // Reporting against known: a node that has gone quiet is the one thing
        // this card cannot show any other way, because it contributes nothing
        // to the figures below.
        <span
          className={cn(
            'font-mono text-[11px]',
            summary && nodes.length < summary.nodes.total ? 'text-blind' : 'text-muted-foreground',
          )}
        >
          {summary ? `${nodes.length}/${summary.nodes.total} nodes` : `${nodes.length} nodes`}
        </span>
      }
    >
      <dl className="mt-1.5 flex flex-col gap-1.5">
        <Meter
          label="CPU"
          percent={cpuShare(nodes)}
          detail={
            threads !== null
              ? `${formatCount(threads)} threads`
              : cores !== null
                ? `${formatCount(cores)} cores`
                : ''
          }
        />
        <Meter
          label="Memory"
          percent={share(memoryUsed, memoryTotal)}
          detail={`${formatBytes(memoryUsed)} / ${formatBytes(memoryTotal)}`}
        />
        <Meter
          label="Node disks"
          percent={share(diskUsed, diskTotal)}
          detail={`${formatBytes(diskUsed)} / ${formatBytes(diskTotal)}`}
        />
      </dl>
    </Card>
  );
}

/** One resource: what it is, how full, and the figures behind the bar. */
function Meter({
  label,
  percent,
  detail,
}: {
  label: string;
  percent: number | null;
  detail: string;
}) {
  return (
    <div className="flex items-center gap-3">
      <dt className="w-20 shrink-0 font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
        {label}
      </dt>
      <dd className="flex min-w-0 flex-1 items-center gap-3">
        <span className="w-14 shrink-0 text-right font-mono text-sm tabular">
          {formatPercent(percent, percent !== null && percent < 10 ? 1 : 0)}
        </span>
        <span aria-hidden className="h-1 flex-1 overflow-hidden rounded-full bg-muted">
          {percent !== null && (
            <span
              className="block h-full rounded-full bg-signal"
              style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
            />
          )}
        </span>
        <span className="shrink-0 truncate font-mono text-[11px] tabular text-muted-foreground">
          {detail}
        </span>
      </dd>
    </div>
  );
}

/**
 * What is running, and what is not.
 *
 * The bar is the cluster's workload in proportion, so an operator sees the
 * shape before reading a number. Each state links to the workloads it stands
 * for — a count nobody can act on is a count nobody reads.
 */
function Pods({ summary }: { summary: ClusterSummary | null }) {
  const pods = summary?.pods;
  const total = pods?.total ?? 0;

  const states = [
    { key: 'Running', count: pods?.running ?? 0, tone: 'bg-signal', text: 'text-foreground' },
    { key: 'Pending', count: pods?.pending ?? 0, tone: 'bg-blind', text: 'text-blind' },
    { key: 'Failed', count: pods?.failed ?? 0, tone: 'bg-bad', text: 'text-bad' },
    {
      key: 'Succeeded',
      count: pods?.succeeded ?? 0,
      tone: 'bg-muted-foreground',
      text: 'text-muted-foreground',
    },
  ];

  return (
    <Card
      title="Pods"
      right={
        <span className="font-mono text-[11px] text-muted-foreground">
          {formatCount(total)} total
        </span>
      }
    >
      <p className="mt-1 font-mono text-xl font-medium tabular">
        {formatCount(pods?.running ?? null)}
        <span className="ml-2 text-sm font-normal text-muted-foreground">running</span>
      </p>

      <span aria-hidden className="mt-2 flex h-1 gap-px overflow-hidden rounded-full bg-muted">
        {total > 0 &&
          states
            .filter((state) => state.count > 0)
            .map((state) => (
              <span
                key={state.key}
                className={cn('block h-full', state.tone)}
                style={{ width: `${(state.count / total) * 100}%` }}
              />
            ))}
      </span>

      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
        {states
          .filter((state) => state.count > 0 && state.key !== 'Running')
          .map((state) => (
            <Link
              key={state.key}
              href={`/workloads?phase=${state.key}`}
              className={cn('font-mono text-[11px] tabular hover:underline', state.text)}
            >
              {formatCount(state.count)} {state.key.toLowerCase()}
            </Link>
          ))}
        {(pods?.degraded ?? 0) > 0 && (
          <Link
            href="/workloads?phase=Running"
            className="font-mono text-[11px] tabular text-blind hover:underline"
          >
            {formatCount(pods?.degraded ?? 0)} not ready
          </Link>
        )}
        {pods && total > 0 && pods.running === total && (
          <span className="font-mono text-[11px] text-muted-foreground">every pod is running</span>
        )}
      </div>
    </Card>
  );
}

/**
 * The short list of things that are not right.
 *
 * Empty most of the time, and says so plainly rather than leaving a blank box
 * that reads as a screen that failed to load.
 */
function Attention({
  summary,
  manifest,
}: {
  summary: ClusterSummary | null;
  manifest: { agent: { installed: boolean; reporting: number; expected: number } } | null;
}) {
  const items: { text: string; href: string; tone: 'bad' | 'blind' }[] = [];

  const notReady = summary ? summary.nodes.total - summary.nodes.ready : 0;
  if (notReady > 0) {
    items.push({
      text: `${formatCount(notReady)} ${notReady === 1 ? 'node is' : 'nodes are'} not ready`,
      href: '/nodes?ready=0',
      tone: 'bad',
    });
  }

  for (const trouble of summary?.pods.troubled ?? []) {
    items.push({
      text: `${formatCount(trouble.count)} × ${trouble.reason}`,
      href: `/workloads?reason=${encodeURIComponent(trouble.reason)}`,
      tone: 'bad',
    });
  }

  if (manifest?.agent.installed && manifest.agent.reporting < manifest.agent.expected) {
    items.push({
      text: `agent silent on ${formatCount(manifest.agent.expected - manifest.agent.reporting)} of ${formatCount(manifest.agent.expected)} nodes`,
      href: '/settings',
      tone: 'blind',
    });
  }

  if ((summary?.warnings ?? 0) > 0) {
    items.push({
      text: `${formatCount(summary?.warnings ?? 0)} warnings in the last hour`,
      href: '/events?type=Warning',
      tone: 'blind',
    });
  }

  return (
    <Card title="Attention">
      {items.length === 0 ? (
        <p className="mt-2 text-xs text-muted-foreground">
          {summary ? 'Nothing is asking for it.' : 'Reading the cluster…'}
        </p>
      ) : (
        <ul className="mt-1.5 flex flex-col gap-1">
          {items.map((item) => (
            <li key={item.href + item.text}>
              <Link
                href={item.href}
                className={cn(
                  'font-mono text-xs tabular hover:underline',
                  item.tone === 'bad' ? 'text-bad' : 'text-blind',
                )}
              >
                {item.text}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/** Every node, with what it is doing right now. */
function NodeTable({ nodes, now }: { nodes: readonly LiveNodeMetrics[]; now: number }) {
  return (
    <div className="pane rounded-lg border border-line">
      <Table className="table-fixed">
        <TableHeader className="sticky top-0 z-10 bg-card">
          <TableRow>
            <Head>Node</Head>
            <Head className="w-[30%] text-right sm:w-[22%] lg:w-[14%]">CPU</Head>
            <Head className="hidden w-[24%] text-right md:table-cell lg:w-[16%]">Memory</Head>
            <Head className="hidden w-[12%] text-right lg:table-cell">Disk</Head>
            <Head className="hidden w-[16%] text-right lg:table-cell">Clock</Head>
            <Head className="hidden w-[15%] text-right xl:table-cell">Network</Head>
            <Head className="w-[26%] text-right sm:w-[18%] lg:w-[13%]">Reading</Head>
          </TableRow>
        </TableHeader>

        <TableBody>
          {nodes.length === 0 && (
            <TableRow>
              <TableCell colSpan={7} className="py-8 text-center text-muted-foreground">
                No node is reporting yet. kubitor reads the kubelet every five seconds.
              </TableCell>
            </TableRow>
          )}

          {nodes.map((node) => (
            <TableRow key={node.node}>
              <TableCell className="max-w-0 truncate">
                <Link
                  href={`/nodes/${encodeURIComponent(node.node)}`}
                  className="font-medium underline-offset-4 hover:underline"
                >
                  {node.node}
                </Link>
              </TableCell>
              <TableCell className="text-right tabular">
                {/*
                  A share of the machine, not millicores against a capacity the
                  reader has to remember. Where the agent reports, this is
                  measured on the host once a second.
                */}
                <Bar percent={node.host?.cpuPercent ?? node.cpuPercent} />
              </TableCell>
              <TableCell className="hidden text-right tabular md:table-cell">
                <Bar
                  percent={node.host?.memPercent ?? node.memoryPercent}
                  aside={formatBytes(node.host?.memUsedBytes ?? node.memoryBytes)}
                />
              </TableCell>
              <TableCell className="hidden text-right tabular lg:table-cell">
                <Bar percent={node.fsPercent} />
              </TableCell>
              <TableCell className="hidden text-right font-mono text-xs tabular lg:table-cell">
                {node.host ? (
                  formatClockPair(node.host.cpuMhzAverage, node.host.cpuMhzMax)
                ) : (
                  // Not a gap in the data: no agent runs here to measure it.
                  <span className="text-blind">no agent</span>
                )}
              </TableCell>
              <TableCell className="hidden text-right font-mono text-xs tabular xl:table-cell">
                ↓ {formatBytesPerSecond(node.host?.netRxBytesPerSecond ?? node.netRxBytesPerSecond)}
                <br />↑{' '}
                {formatBytesPerSecond(node.host?.netTxBytesPerSecond ?? node.netTxBytesPerSecond)}
              </TableCell>
              <TableCell className="text-right">
                <Age
                  sampledAt={node.host?.sampledAt ?? node.sampledAt}
                  now={now}
                  className="justify-end"
                />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function Head({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <TableHead
      className={cn('max-w-0 truncate font-mono text-[10px] uppercase tracking-[0.1em]', className)}
    >
      {children}
    </TableHead>
  );
}

/** A percentage worth reading at a glance, with the figure kept beside it. */
function Bar({ percent, aside }: { percent: number | null; aside?: string }) {
  if (percent === null) {
    return <span className="font-mono text-xs text-blind">—</span>;
  }

  return (
    <span className="inline-flex items-center gap-2">
      <span aria-hidden className="h-1 w-12 overflow-hidden rounded-full bg-muted">
        <span
          className="block h-full rounded-full bg-signal"
          style={{ width: `${Math.min(100, percent)}%` }}
        />
      </span>
      <span className="font-mono text-xs">{formatPercent(percent, 0)}</span>
      {aside && <span className="font-mono text-[11px] text-muted-foreground">{aside}</span>}
    </span>
  );
}

/**
 * The cluster's utilisation, weighted by the size of each machine.
 *
 * A plain average of percentages treats a two-core node and a sixty-core node
 * as equals, which is how a busy cluster reports itself as idle.
 */
function cpuShare(nodes: readonly LiveNodeMetrics[]): number | null {
  let weighted = 0;
  let weight = 0;

  for (const node of nodes) {
    const percent = node.host?.cpuPercent ?? node.cpuPercent;
    if (percent === null) continue;

    // Threads where the agent counted them, declared cores otherwise, and one
    // as a last resort so a node with no capacity still carries its own weight.
    const size = node.host?.cpuCores ?? ((node.capacityCpuMilli ?? 1000) / 1000 || 1);
    weighted += percent * size;
    weight += size;
  }

  return weight === 0 ? null : weighted / weight;
}

function share(used: number | null, total: number | null): number | null {
  if (used === null || total === null || total <= 0) return null;
  return (used / total) * 100;
}

/** Null unless something answered: a sum of nothing is not zero. */
function sum(values: readonly (number | null)[]): number | null {
  const usable = values.filter((value): value is number => value !== null);
  return usable.length === 0 ? null : usable.reduce((total, value) => total + value, 0);
}

/** The newest reading on screen, whichever source produced it. */
function freshest(
  nodes: readonly { sampledAt: number; host?: { sampledAt: number } }[],
): number | null {
  const times = nodes.flatMap((node) => [
    node.sampledAt,
    ...(node.host ? [node.host.sampledAt] : []),
  ]);
  return times.length === 0 ? null : Math.max(...times);
}
