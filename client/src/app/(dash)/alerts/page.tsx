'use client';

import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { AlertRecord, AlertsPage as AlertsData } from '@/lib/api';
import { api } from '@/lib/api';
import { formatTimestamp } from '@/lib/format';

/** How long a firing alert has been going on, in words that hold still. */
function held(from: number, to: number): string {
  const minutes = Math.max(1, Math.round((to - from) / 60_000));
  if (minutes < 60) return `${minutes}m`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/**
 * What is wrong, and what has been wrong.
 *
 * Firing alerts lead, because they are the reason anybody opens this. The
 * history below them is what answers the question an operator asks next —
 * whether this has happened before — and it is why a recurrence is a new record
 * rather than a revived one.
 */
export default function AlertsPage() {
  const [firing, setFiring] = useState<AlertRecord[]>([]);
  const [recent, setRecent] = useState<AlertRecord[]>([]);
  const [delivery, setDelivery] = useState<AlertsData['delivery'] | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const load = async (): Promise<void> => {
      const page = await api.alerts();
      if (cancelled) return;
      setFiring(page.firing);
      setRecent(page.recent);
      setDelivery(page.delivery);
      setLoaded(true);
    };

    void load();
    // Rules are evaluated once a minute; asking faster would only redraw the
    // same rows, and this screen is one people leave open.
    const timer = setInterval(() => void load(), 30_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const now = Date.now();

  return (
    <div className="screen gap-3">
      <div className="flex flex-wrap items-baseline gap-3">
        <h1 className="text-base font-semibold tracking-tight">Alerts</h1>
        <span className="font-mono text-xs text-muted-foreground">
          {firing.length === 0 ? (loaded ? 'nothing firing' : '') : `${firing.length} firing`}
        </span>
      </div>

      <div className="pane flex flex-col gap-4 pr-1">
        {delivery && <Delivery delivery={delivery} />}

        {loaded && firing.length === 0 && (
          <p className="rounded-lg border border-line p-4 text-sm text-muted-foreground">
            Nothing is firing. Rules are evaluated once a minute, and a condition has to hold for
            more than one evaluation before it appears here — a pod that restarts once, or a node
            that blinks while its kubelet restarts, never reaches this screen.
          </p>
        )}

        {firing.length > 0 && (
          <div className="flex flex-col gap-2">
            {firing.map((alert) => (
              <div key={alert.id} className="flex flex-col gap-1 rounded-lg border border-line p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={alert.severity === 'critical' ? 'destructive' : 'secondary'}>
                    {alert.severity}
                  </Badge>
                  <span className="text-sm font-medium">{alert.summary}</span>
                  <span className="ml-auto font-mono text-xs text-muted-foreground">
                    {held(alert.firedAt ?? alert.firstSeenAt, now)}
                  </span>
                </div>
                {alert.detail && <p className="text-sm text-muted-foreground">{alert.detail}</p>}
                <span className="font-mono text-[11px] text-muted-foreground">
                  {alert.rule} · {alert.subject} · since{' '}
                  {formatTimestamp(alert.firedAt ?? alert.firstSeenAt)}
                </span>
              </div>
            ))}
          </div>
        )}

        <div className="rounded-lg border border-line">
          <Table className="table-fixed">
            <TableHeader className="sticky top-0 z-10 bg-card">
              <TableRow>
                <TableHead className="w-[10%] truncate font-mono text-[11px] uppercase tracking-[0.1em]">
                  State
                </TableHead>
                <TableHead className="truncate font-mono text-[11px] uppercase tracking-[0.1em]">
                  What
                </TableHead>
                <TableHead className="hidden w-[18%] truncate font-mono text-[11px] uppercase tracking-[0.1em] md:table-cell">
                  Rule
                </TableHead>
                <TableHead className="w-[20%] truncate font-mono text-[11px] uppercase tracking-[0.1em]">
                  Started
                </TableHead>
                <TableHead className="hidden w-[20%] truncate font-mono text-[11px] uppercase tracking-[0.1em] lg:table-cell">
                  Ended
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loaded && recent.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">
                    Nothing has been wrong yet.
                  </TableCell>
                </TableRow>
              )}

              {recent.map((alert) => (
                <TableRow key={alert.id}>
                  <TableCell className="max-w-0 truncate">
                    {alert.resolvedAt !== null ? (
                      <Badge variant="outline">Resolved</Badge>
                    ) : alert.state === 'firing' ? (
                      <Badge variant={alert.severity === 'critical' ? 'destructive' : 'secondary'}>
                        Firing
                      </Badge>
                    ) : (
                      // Seen, but not yet long enough to be anybody's problem.
                      <Badge variant="outline" className="border-blind text-blind">
                        Watching
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="max-w-0 truncate">{alert.summary}</TableCell>
                  <TableCell className="hidden max-w-0 truncate font-mono text-xs text-muted-foreground md:table-cell">
                    {alert.rule}
                  </TableCell>
                  <TableCell className="max-w-0 truncate font-mono text-xs text-muted-foreground">
                    {formatTimestamp(alert.firstSeenAt)}
                  </TableCell>
                  <TableCell className="hidden max-w-0 truncate font-mono text-xs text-muted-foreground lg:table-cell">
                    {alert.resolvedAt === null ? '—' : formatTimestamp(alert.resolvedAt)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>
    </div>
  );
}

/**
 * Whether anybody is actually being told.
 *
 * The failure worth catching here is silent: notifications configured, a
 * webhook rotated months ago, messages piling up unsent, and everybody assuming
 * they would have heard by now. A number that is not zero says so.
 */
function Delivery({ delivery }: { delivery: AlertsData['delivery'] }) {
  if (!delivery.configured) {
    return (
      <p className="rounded-lg border border-line p-3 text-sm text-muted-foreground">
        Alerts are recorded here and sent nowhere. Set{' '}
        <code className="font-mono text-xs">KUBITOR_NOTIFY_DISCORD_WEBHOOK</code>,{' '}
        <code className="font-mono text-xs">KUBITOR_NOTIFY_SLACK_WEBHOOK</code>,{' '}
        <code className="font-mono text-xs">KUBITOR_NOTIFY_TELEGRAM_TOKEN</code> or{' '}
        <code className="font-mono text-xs">KUBITOR_NOTIFY_WEBHOOK_URL</code> to have them reach
        somewhere people look.
      </p>
    );
  }

  const failed = delivery.recent.filter(
    (message) => message.finishedAt !== null && !message.delivered,
  );

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-line p-3 text-sm">
      <span className="text-muted-foreground">Delivery</span>
      {delivery.pending === 0 ? (
        <Badge variant="secondary">up to date</Badge>
      ) : (
        <Badge variant="outline" className="border-blind text-blind">
          {delivery.pending} waiting
        </Badge>
      )}
      {failed.length > 0 && (
        <>
          <Badge variant="destructive">{failed.length} undelivered</Badge>
          <span className="font-mono text-xs text-muted-foreground">{failed[0]?.error}</span>
        </>
      )}
    </div>
  );
}
