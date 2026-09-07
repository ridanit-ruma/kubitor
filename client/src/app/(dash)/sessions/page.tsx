'use client';

import { useEffect, useState } from 'react';
import { type Column, FacetTable } from '@/components/facet-table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { api } from '@/lib/api';
import { formatTimestamp } from '@/lib/format';

interface SessionRow extends Record<string, unknown> {
  node: string;
  user: string;
  tty: string | null;
  kind: string;
  pid: number;
  since: number;
  from_ip: string | null;
}

interface CommandRow extends Record<string, unknown> {
  at: number;
  pid: number;
  comm: string;
  argv: string;
  source: string;
}

interface AccessRow extends Record<string, unknown> {
  at: number;
  node: string;
  outcome: string;
  method: string;
  user: string;
  client_ip: string;
  client_port: number | null;
}

/** How long a session has been open, in words that hold still. */
function open(since: number, now: number): string {
  const minutes = Math.max(1, Math.round((now - since) / 60_000));
  if (minutes < 60) return `${minutes}m`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

const OUTCOMES: Record<string, { label: string; tone: 'ok' | 'bad' | 'quiet' }> = {
  accepted: { label: 'accepted', tone: 'ok' },
  failed: { label: 'failed', tone: 'bad' },
  // Somebody guessing at account names, which reads differently from somebody
  // getting their own password wrong.
  invalid_user: { label: 'no such user', tone: 'bad' },
  disconnected: { label: 'disconnected', tone: 'quiet' },
};

const sessionColumns = (now: number): Column<SessionRow>[] => [
  {
    key: 'user',
    header: 'Who',
    render: (row) => <span className="font-medium">{row.user}</span>,
  },
  {
    key: 'node',
    header: 'Where',
    width: 'w-[20%]',
    render: (row) => <span className="font-mono text-xs">{row.node}</span>,
  },
  {
    key: 'kind',
    header: 'Kind',
    width: 'w-[14%]',
    priority: 'sm',
    render: (row) => (
      <span className="font-mono text-xs text-muted-foreground">{row.tty ?? row.kind}</span>
    ),
  },
  {
    key: 'since',
    header: 'Open for',
    width: 'w-[14%]',
    align: 'right',
    render: (row) => <span className="tabular">{open(row.since, now)}</span>,
  },
  {
    key: 'from_ip',
    header: 'From',
    width: 'w-[18%]',
    priority: 'lg',
    render: (row) => (
      <span className="font-mono text-xs text-muted-foreground">{row.from_ip ?? '—'}</span>
    ),
  },
];

const accessColumns: Column<AccessRow>[] = [
  {
    key: 'at',
    header: 'When',
    width: 'w-[20%]',
    render: (row) => <span className="font-mono text-xs">{formatTimestamp(row.at)}</span>,
  },
  {
    key: 'outcome',
    header: 'Outcome',
    width: 'w-[16%]',
    render: (row) => {
      const outcome = OUTCOMES[row.outcome] ?? { label: row.outcome, tone: 'quiet' as const };
      return (
        <Badge
          variant={
            outcome.tone === 'bad' ? 'destructive' : outcome.tone === 'ok' ? 'secondary' : 'outline'
          }
        >
          {outcome.label}
        </Badge>
      );
    },
  },
  {
    key: 'user',
    header: 'Account',
    render: (row) => <span className="font-mono text-xs">{row.user || '—'}</span>,
  },
  {
    key: 'client_ip',
    header: 'From',
    width: 'w-[20%]',
    render: (row) => <span className="font-mono text-xs">{row.client_ip}</span>,
  },
  {
    key: 'method',
    header: 'Method',
    width: 'w-[16%]',
    priority: 'md',
    render: (row) => <span className="font-mono text-xs text-muted-foreground">{row.method}</span>,
  },
  {
    key: 'node',
    header: 'Machine',
    width: 'w-[16%]',
    priority: 'lg',
    render: (row) => <span className="font-mono text-xs text-muted-foreground">{row.node}</span>,
  },
];

/**
 * Who is logged in, and who has tried.
 *
 * Two tables on one screen because they are one subject read at two time
 * scales, and splitting them would make an operator cross-reference by hand:
 * the useful question about a failed attempt is almost always whether it later
 * succeeded.
 */
export default function SessionsPage() {
  const [tab, setTab] = useState<'open' | 'attempts'>('open');
  const [opened, setOpened] = useState<SessionRow | null>(null);
  const now = Date.now();

  return (
    <div className="screen gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-base font-semibold tracking-tight">Sessions</h1>
        <div className="ml-auto flex gap-1">
          <Button
            variant={tab === 'open' ? 'secondary' : 'ghost'}
            size="sm"
            onClick={() => setTab('open')}
          >
            Open now
          </Button>
          <Button
            variant={tab === 'attempts' ? 'secondary' : 'ghost'}
            size="sm"
            onClick={() => setTab('attempts')}
          >
            Attempts
          </Button>
        </div>
      </div>

      {tab === 'open' ? (
        <FacetTable<SessionRow>
          facet="sessions"
          columns={sessionColumns(now)}
          searchPlaceholder="Find a session by account, machine or terminal"
          emptyMessage="Nobody is logged in to any machine reporting sessions."
          rowKey={(row) => `${row.node}:${row.pid}`}
          onRowClick={(row) => setOpened(row)}
        />
      ) : (
        <FacetTable<AccessRow>
          facet="access"
          columns={accessColumns}
          filters={[
            {
              key: 'outcome',
              label: 'Outcomes',
              values: ['accepted', 'failed', 'invalid_user', 'disconnected'],
            },
          ]}
          searchPlaceholder="Find an attempt by account, address or machine"
          emptyMessage="No login attempt has been recorded. Attempts are read from an auth log; a machine that logs only to journald has none to read."
        />
      )}
      <SessionCommands session={opened} onClose={() => setOpened(null)} />
    </div>
  );
}

/**
 * What ran inside one session.
 *
 * On the session rather than on a screen of its own. A global feed of every
 * command on every machine invites being read as an audit trail, which sampled
 * rows are not — and the question anybody actually has is about one session.
 */
function SessionCommands({ session, onClose }: { session: SessionRow | null; onClose(): void }) {
  const [commands, setCommands] = useState<CommandRow[] | null>(null);

  useEffect(() => {
    if (!session) {
      setCommands(null);
      return;
    }

    let cancelled = false;
    void (async () => {
      const query = new URLSearchParams({
        node: session.node,
        session_pid: String(session.pid),
        limit: '200',
      });
      const page = await api.facet('commands', query);
      if (!cancelled) setCommands(page.rows as CommandRow[]);
    })();

    return () => {
      cancelled = true;
    };
  }, [session]);

  if (!session) return null;

  const sampled = commands?.some((command) => command.source === 'sampled') ?? true;

  return (
    <Sheet open onOpenChange={(next) => !next && onClose()}>
      <SheetContent side="right" className="w-full gap-0 overflow-y-auto sm:max-w-xl">
        <SheetHeader>
          <SheetTitle className="font-mono text-sm">
            {session.user} on {session.node}
          </SheetTitle>
          <SheetDescription>
            {sampled
              ? 'Sampled once a second, so anything shorter than that is not here. An absence is not evidence that nothing ran.'
              : 'From auditd, which sees every execution.'}
          </SheetDescription>
        </SheetHeader>

        <div className="flex flex-col gap-2 px-4 pb-6">
          {commands === null && <p className="text-sm text-muted-foreground">Reading…</p>}

          {commands?.length === 0 && (
            <p className="text-sm text-muted-foreground">
              Nothing has been sampled in this session. Commands are recorded only where the agent
              is set to <code className="font-mono text-xs">KUBITOR_AGENT_SESSIONS=full</code>.
            </p>
          )}

          {commands?.map((command) => (
            <div key={`${command.pid}-${command.at}`} className="flex flex-col gap-0.5">
              <span className="font-mono text-xs break-all">{command.argv || command.comm}</span>
              <span className="font-mono text-[11px] text-muted-foreground">
                {formatTimestamp(command.at)} · pid {command.pid} · {command.source}
              </span>
            </div>
          ))}
        </div>
      </SheetContent>
    </Sheet>
  );
}
