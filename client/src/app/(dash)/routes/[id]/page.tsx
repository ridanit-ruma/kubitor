'use client';

import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ResourceCard } from '@/components/resource-card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { api } from '@/lib/api';
import { formatBytes, formatDuration, formatPercent, formatTimestamp } from '@/lib/format';
import { decodeRouteId } from '@/lib/route-id';

interface RouteRow extends Record<string, unknown> {
  kind: string;
  namespace: string;
  name: string;
  host: string;
  path: string;
  service: string;
  port: number | null;
  tls: number;
  class: string | null;
  integration: string;
  attrs: Record<string, unknown>;
}

interface AccessRow extends Record<string, unknown> {
  at: number;
  host: string;
  method: string;
  path: string;
  status: number;
  duration_ms: number;
  client_ip: string;
  route: string | null;
  bytes_out: number | null;
}

/** Requests pulled to characterize a route. Enough to be representative, capped. */
const SAMPLE_SIZE = 200;

/**
 * One route, and everything kubitor knows about it.
 *
 * The definition, whatever the publishing vendor added on top of it, and what
 * has actually been arriving at that address. A route that exists and a route
 * that works are different claims, and this is where the second one is
 * answerable.
 */
export default function RouteDetailPage() {
  const params = useParams<{ id: string }>();
  const key = decodeRouteId(params.id);

  const [route, setRoute] = useState<RouteRow | null>(null);
  const [requests, setRequests] = useState<AccessRow[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!key) {
      setLoaded(true);
      return;
    }

    let cancelled = false;

    const load = async (): Promise<void> => {
      const [routes, access] = await Promise.allSettled([
        api.facet(
          'routes',
          new URLSearchParams({ namespace: key.namespace, search: key.name, limit: '100' }),
        ),
        api.facet(
          'http-access',
          new URLSearchParams({ host: key.host, limit: String(SAMPLE_SIZE) }),
        ),
      ]);
      if (cancelled) return;

      const rows = routes.status === 'fulfilled' ? (routes.value.rows as RouteRow[]) : [];
      setRoute(
        rows.find(
          (row) => row.name === key.name && row.host === key.host && row.path === key.path,
        ) ?? null,
      );

      // The access facet filters by host; the path narrowing happens here
      // because a route's path is a prefix, not an equality.
      const served = access.status === 'fulfilled' ? (access.value.rows as AccessRow[]) : [];
      setRequests(served.filter((row) => matchesPath(row.path, key.path)));
      setLoaded(true);
    };

    void load();
    const timer = setInterval(() => void load(), 15_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [key]);

  if (!key) {
    return <NotFound reason="That route link could not be read." />;
  }
  if (loaded && !route) {
    return <NotFound reason={`No route named ${key.name} is published for ${key.host}.`} />;
  }

  const failures = requests.filter((row) => row.status >= 500).length;
  const slowest = requests.reduce((worst, row) => Math.max(worst, row.duration_ms), 0);
  const attrs = Object.entries(route?.attrs ?? {}).filter(([, value]) => value !== null);

  return (
    <div className="screen gap-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Button asChild variant="ghost" size="sm">
          <Link href="/routes">
            <ArrowLeft className="size-4" />
            Routes
          </Link>
        </Button>
        <h1 className="font-mono text-base font-semibold tracking-tight">
          {key.host}
          <span className="text-muted-foreground">{key.path}</span>
        </h1>
        {route?.tls === 1 ? (
          <Badge variant="secondary">TLS</Badge>
        ) : (
          <Badge variant="outline">plain</Badge>
        )}
      </div>

      <div className="pane flex flex-col gap-3 pr-1">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <ResourceCard
            label="Requests seen"
            headline={String(requests.length)}
            detail={`of the last ${SAMPLE_SIZE} to this host`}
          />
          <ResourceCard
            label="Server errors"
            headline={
              requests.length === 0 ? '—' : formatPercent((failures / requests.length) * 100, 1)
            }
            percent={requests.length === 0 ? null : (failures / requests.length) * 100}
            tone={failures > 0 ? 'blind' : 'signal'}
            detail={`${failures} of ${requests.length} answered 5xx`}
          />
          <ResourceCard
            label="Slowest"
            headline={requests.length === 0 ? '—' : formatDuration(slowest)}
            detail="in this sample"
          />
        </div>

        <section className="rounded-lg border border-line bg-card px-4 py-3">
          <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
            Definition
          </p>
          <dl className="mt-3 grid grid-cols-1 gap-x-8 gap-y-2 sm:grid-cols-2">
            <Field label="Backend">
              {route ? `${route.service}${route.port === null ? '' : `:${route.port}`}` : '—'}
            </Field>
            <Field label="Object">
              {route ? `${route.kind} ${route.namespace}/${route.name}` : '—'}
            </Field>
            <Field label="Published by">{route?.integration ?? '—'}</Field>
            <Field label="Ingress class">{route?.class ?? 'none'}</Field>
            {attrs.map(([attr, value]) => (
              <Field key={attr} label={attr.replaceAll('_', ' ')}>
                {typeof value === 'object' ? JSON.stringify(value) : String(value)}
              </Field>
            ))}
          </dl>
        </section>

        <section className="rounded-lg border border-line bg-card">
          <p className="px-4 pt-3 font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
            Recent requests
          </p>

          {requests.length === 0 ? (
            <p className="px-4 py-6 text-sm text-muted-foreground">
              {loaded
                ? 'Nothing has reached this route in the requests kubitor has kept.'
                : 'Loading…'}
            </p>
          ) : (
            <Table className="mt-2 table-fixed">
              <TableHeader>
                <TableRow>
                  <Head className="w-[34%] sm:w-[22%]">When</Head>
                  <Head className="w-[22%] sm:w-[12%]">Status</Head>
                  <Head className="hidden w-[12%] sm:table-cell">Method</Head>
                  <Head>Path</Head>
                  <Head className="hidden w-[20%] text-right sm:table-cell">Took</Head>
                </TableRow>
              </TableHeader>
              <TableBody>
                {requests.slice(0, 50).map((row) => (
                  <TableRow key={`${row.at}-${row.path}-${row.client_ip}`}>
                    <TableCell className="max-w-0 truncate font-mono text-xs">
                      {formatTimestamp(row.at)}
                    </TableCell>
                    <TableCell className="max-w-0 truncate">
                      <Badge variant={statusTone(row.status)}>{row.status}</Badge>
                    </TableCell>
                    <TableCell className="hidden max-w-0 truncate font-mono text-xs sm:table-cell">
                      {row.method}
                    </TableCell>
                    <TableCell className="max-w-0 truncate font-mono text-xs">{row.path}</TableCell>
                    <TableCell className="hidden max-w-0 truncate text-right font-mono text-xs tabular sm:table-cell">
                      {formatDuration(row.duration_ms)}
                      {row.bytes_out !== null && (
                        <span className="ml-2 text-muted-foreground">
                          {formatBytes(row.bytes_out)}
                        </span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </section>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
        {label}
      </dt>
      <dd className="mt-0.5 break-words font-mono text-sm">{children}</dd>
    </div>
  );
}

function Head({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <TableHead
      className={`max-w-0 truncate font-mono text-[11px] uppercase tracking-[0.1em] ${className ?? ''}`}
    >
      {children}
    </TableHead>
  );
}

function NotFound({ reason }: { reason: string }) {
  return (
    <div className="screen gap-3">
      <Button asChild variant="ghost" size="sm" className="self-start">
        <Link href="/routes">
          <ArrowLeft className="size-4" />
          Routes
        </Link>
      </Button>
      <p className="text-sm text-muted-foreground">{reason}</p>
    </div>
  );
}

/** A route's path is a prefix; `/` matches everything published under it. */
function matchesPath(requestPath: string, routePath: string): boolean {
  if (routePath === '' || routePath === '/') return true;
  return requestPath === routePath || requestPath.startsWith(`${routePath}/`);
}

function statusTone(status: number): 'secondary' | 'outline' | 'destructive' {
  if (status >= 500) return 'destructive';
  if (status >= 400) return 'outline';
  return 'secondary';
}
