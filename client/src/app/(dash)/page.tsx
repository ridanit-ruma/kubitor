'use client';

import Link from 'next/link';
import { Age } from '@/components/age';
import { CapabilityStrip } from '@/components/capability-strip';
import { StatTile } from '@/components/stat-tile';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { LiveNodeMetrics } from '@/lib/api';
import { formatBytes, formatBytesPerSecond, formatClockPair, formatPercent } from '@/lib/format';
import { useLiveMetrics, useNow } from '@/lib/live';
import { useManifest } from '@/lib/manifest-context';

export default function OverviewPage() {
  const { manifest } = useManifest();
  const live = useLiveMetrics();
  const now = useNow();

  // The agent measures the host's interfaces once a second; the kubelet reports
  // a counter every five, and a rate taken across two of those moves in steps.
  // Prefer the finer source, exactly as the node screen does.
  const totalRx = sum(live.nodes.map(netRx));
  const totalTx = sum(live.nodes.map(netTx));

  return (
    <div className="screen gap-4">
      <div className="flex items-baseline justify-between gap-4">
        <h1 className="text-lg font-semibold tracking-tight">Overview</h1>
        <Age sampledAt={freshest(live.nodes) ?? live.sampledAt} now={now} />
      </div>

      {manifest && <CapabilityStrip manifest={manifest} />}

      <div className="grid shrink-0 grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile
          label="Nodes reporting"
          value={
            manifest ? `${live.nodes.length}/${manifest.cluster.nodes}` : String(live.nodes.length)
          }
          // A working socket needs no caption; a broken one does.
          detail={live.connected ? undefined : 'reconnecting'}
          tone={
            manifest && live.nodes.length < manifest.cluster.nodes && manifest.cluster.nodes > 0
              ? 'blind'
              : 'normal'
          }
        />
        <StatTile
          label="Received"
          value={formatBytesPerSecond(totalRx)}
          detail="across physical interfaces"
        />
        <StatTile label="Transmitted" value={formatBytesPerSecond(totalTx)} />
        <StatTile
          label="Agent"
          value={
            manifest?.agent.installed
              ? `${manifest.agent.reporting}/${manifest.agent.expected}`
              : 'not installed'
          }
          detail={
            manifest?.agent.installed
              ? 'nodes reporting host metrics'
              : 'clocks, host RAM and sensors need it'
          }
          tone={manifest?.agent.installed ? 'normal' : 'blind'}
        />
      </div>

      <div className="pane rounded-lg border border-line">
        {/* Fixed layout: a long node name shortens itself rather than pushing
            the reading off the right-hand edge. */}
        <Table className="table-fixed">
          <TableHeader className="sticky top-0 z-10 bg-card">
            <TableRow>
              <TableHead className="truncate font-mono text-[11px] uppercase tracking-[0.1em]">
                Node
              </TableHead>
              <TableHead className="w-[30%] truncate text-right font-mono text-[11px] uppercase tracking-[0.1em] sm:w-[22%] lg:w-[14%]">
                CPU
              </TableHead>
              <TableHead className="hidden w-[24%] truncate text-right font-mono text-[11px] uppercase tracking-[0.1em] md:table-cell lg:w-[16%]">
                Memory
              </TableHead>
              <TableHead className="hidden w-[12%] truncate text-right font-mono text-[11px] uppercase tracking-[0.1em] lg:table-cell">
                Disk
              </TableHead>
              <TableHead className="hidden w-[16%] truncate text-right font-mono text-[11px] uppercase tracking-[0.1em] lg:table-cell">
                Clock
              </TableHead>
              <TableHead className="hidden w-[15%] truncate text-right font-mono text-[11px] uppercase tracking-[0.1em] xl:table-cell">
                Network
              </TableHead>
              <TableHead className="w-[26%] truncate text-right font-mono text-[11px] uppercase tracking-[0.1em] sm:w-[18%] lg:w-[13%]">
                Reading
              </TableHead>
            </TableRow>
          </TableHeader>

          <TableBody>
            {live.nodes.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="py-10 text-center text-muted-foreground">
                  No node is reporting yet. kubitor reads the kubelet every five seconds.
                </TableCell>
              </TableRow>
            )}

            {[...live.nodes]
              .sort((a, b) => a.node.localeCompare(b.node))
              .map((node) => (
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
                      A share of the machine, not millicores against a capacity
                      the reader has to remember. Where the agent reports, this
                      is measured on the host once a second.
                    */}
                    <Meter percent={node.host?.cpuPercent ?? node.cpuPercent} />
                  </TableCell>
                  <TableCell className="hidden text-right tabular md:table-cell">
                    <Meter percent={node.host?.memPercent ?? node.memoryPercent} />
                    <span className="ml-2 font-mono text-xs text-muted-foreground">
                      {formatBytes(node.host?.memUsedBytes ?? node.memoryBytes)}
                    </span>
                  </TableCell>
                  <TableCell className="hidden text-right tabular lg:table-cell">
                    <Meter percent={node.fsPercent} />
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
                    ↓ {formatBytesPerSecond(netRx(node))}
                    <br />↑ {formatBytesPerSecond(netTx(node))}
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
    </div>
  );
}

/** A percentage worth reading at a glance, with the figure kept beside it. */
function Meter({ percent }: { percent: number | null }) {
  if (percent === null) {
    return <span className="font-mono text-xs text-blind">—</span>;
  }

  return (
    <span className="inline-flex items-center gap-2">
      <span aria-hidden className="h-1.5 w-16 overflow-hidden rounded-full bg-muted">
        <span
          className="block h-full rounded-full bg-signal"
          style={{ width: `${Math.min(100, percent)}%` }}
        />
      </span>
      <span className="font-mono text-xs">{formatPercent(percent, 0)}</span>
    </span>
  );
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

/** The host's own measurement where an agent reports it, the kubelet's otherwise. */
function netRx(node: LiveNodeMetrics): number | null {
  return node.host?.netRxBytesPerSecond ?? node.netRxBytesPerSecond;
}

function netTx(node: LiveNodeMetrics): number | null {
  return node.host?.netTxBytesPerSecond ?? node.netTxBytesPerSecond;
}

function sum(values: readonly (number | null)[]): number | null {
  const usable = values.filter((value): value is number => value !== null);
  return usable.length === 0 ? null : usable.reduce((total, value) => total + value, 0);
}
