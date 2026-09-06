'use client';

import { ArrowLeft, KeyRound, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Age } from '@/components/age';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { type AgentSummary, ApiError, api } from '@/lib/api';
import { formatTimestamp } from '@/lib/format';
import { useNow } from '@/lib/live';

type Pending = { kind: 'issue' } | { kind: 'revoke'; agent: AgentSummary };

/**
 * Credentials for agents that cannot present a service-account token.
 *
 * An agent inside the cluster proves which node it is with a token the API
 * server signed, so nothing has to be distributed. A machine outside the
 * cluster has no such proof, and this is where it is given one.
 */
export default function AgentsPage() {
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [pending, setPending] = useState<Pending | null>(null);
  const [issued, setIssued] = useState<{ name: string; token: string } | null>(null);
  const now = useNow();

  const load = useCallback(async () => {
    setAgents((await api.agents()).agents);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="screen gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <Button asChild variant="ghost" size="sm">
          <Link href="/settings">
            <ArrowLeft className="size-4" />
            Integrations
          </Link>
        </Button>
        <h1 className="text-base font-semibold tracking-tight">Agents</h1>
        <Button size="sm" className="ml-auto" onClick={() => setPending({ kind: 'issue' })}>
          <KeyRound className="size-3.5" />
          Issue a token
        </Button>
      </div>

      <p className="max-w-2xl text-sm text-muted-foreground">
        Agents running as a DaemonSet need nothing here: each pod presents a token the API server
        signed, naming the node it runs on. A machine outside the cluster has no such token, so it
        gets one of these instead. The token is the machine&rsquo;s identity — one per machine, and
        revoking it stops that machine reporting immediately.
      </p>

      <div className="pane rounded-lg border border-line">
        <Table className="table-fixed">
          <TableHeader className="sticky top-0 z-10 bg-card">
            <TableRow>
              <TableHead className="truncate font-mono text-[11px] uppercase tracking-[0.1em]">
                Host
              </TableHead>
              <TableHead className="w-[30%] truncate font-mono text-[11px] uppercase tracking-[0.1em] sm:w-[20%]">
                Reporting
              </TableHead>
              <TableHead className="hidden w-[24%] truncate font-mono text-[11px] uppercase tracking-[0.1em] md:table-cell">
                Issued
              </TableHead>
              <TableHead className="w-[24%] truncate text-right font-mono text-[11px] uppercase tracking-[0.1em]">
                Actions
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {agents.length === 0 && (
              <TableRow>
                <TableCell colSpan={4} className="py-8 text-center text-muted-foreground">
                  No token has been issued. Every agent here reports from inside the cluster.
                </TableCell>
              </TableRow>
            )}

            {agents.map((agent) => (
              <TableRow key={agent.name}>
                <TableCell className="max-w-0 truncate font-medium">
                  {agent.name}
                  {agent.isNode && (
                    <Badge variant="outline" className="ml-2 border-blind text-blind">
                      also a node
                    </Badge>
                  )}
                </TableCell>
                <TableCell className="max-w-0 truncate">
                  <Age sampledAt={agent.lastSeenAt} now={now} staleAfterMs={120_000} />
                </TableCell>
                <TableCell className="hidden max-w-0 truncate font-mono text-xs text-muted-foreground md:table-cell">
                  {formatTimestamp(agent.createdAt)}
                </TableCell>
                <TableCell className="text-right">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setPending({ kind: 'revoke', agent })}
                  >
                    <Trash2 className="size-3.5" />
                    <span className="sr-only lg:not-sr-only">Revoke</span>
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {agents.some((agent) => agent.isNode) && (
        <p className="max-w-2xl text-sm text-blind">
          A token whose name is also a cluster node is a second way to report as that node, weaker
          than the one the API server signs. That is a supported setup where a kubelet cannot
          project tokens — but if you did not mean to create it, revoke it.
        </p>
      )}

      <StepUpDialog
        key={
          pending === null
            ? 'none'
            : `${pending.kind}-${'agent' in pending ? pending.agent.name : ''}`
        }
        pending={pending}
        onClose={() => setPending(null)}
        onDone={async (result) => {
          setPending(null);
          if (result) setIssued(result);
          await load();
        }}
      />

      <IssuedDialog issued={issued} onClose={() => setIssued(null)} />
    </div>
  );
}

/** The plaintext, once. Beside it, what the host has to be told. */
function IssuedDialog({
  issued,
  onClose,
}: {
  issued: { name: string; token: string } | null;
  onClose(): void;
}) {
  return (
    <Dialog open={issued !== null} onOpenChange={onClose}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Token for {issued?.name}</DialogTitle>
          <DialogDescription>
            Shown once. Only its hash is stored, so there is no way to read it again — issue a new
            one if it is lost, which replaces this.
          </DialogDescription>
        </DialogHeader>

        <pre className="overflow-x-auto rounded border border-line bg-muted px-3 py-2 font-mono text-xs">
          {`KUBITOR_SERVER_URL=${typeof window === 'undefined' ? 'https://kubitor.example.com' : window.location.origin}
KUBITOR_HOST_NAME=${issued?.name}
KUBITOR_AGENT_TOKEN=${issued?.token}`}
        </pre>

        <p className="text-sm text-muted-foreground">
          Put these in the agent&rsquo;s environment file, then start it. The machine appears under
          Hosts once it reports.
        </p>

        <DialogFooter>
          <Button onClick={onClose}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function StepUpDialog({
  pending,
  onClose,
  onDone,
}: {
  pending: Pending | null;
  onClose(): void;
  onDone(result: { name: string; token: string } | null): Promise<void>;
}) {
  const [name, setName] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Remounted by its key whenever the target changes, so the fields start empty
  // without an effect that has to remember to clear them.
  if (!pending) return null;

  const title = pending.kind === 'issue' ? 'Issue a token' : `Revoke ${pending.agent.name}`;

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      if (pending.kind === 'issue') {
        await onDone(await api.issueAgent(name, currentPassword));
      } else {
        await api.revokeAgent(pending.agent.name, currentPassword);
        toast.success(`Revoked ${pending.agent.name}. It can no longer report.`);
        await onDone(null);
      }
    } catch (caught) {
      setError(messageFor(caught));
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent>
        <form onSubmit={submit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>
              {pending.kind === 'issue'
                ? 'Name the machine as you want it to appear. Issuing again for a name replaces its token.'
                : 'That machine stops reporting at once. Anything it has already sent is kept.'}
            </DialogDescription>
          </DialogHeader>

          {pending.kind === 'issue' && (
            <div className="space-y-2">
              <Label htmlFor="agent-name">Host name</Label>
              <Input
                id="agent-name"
                autoFocus
                required
                pattern="[a-z0-9][a-z0-9.\-]*"
                placeholder="buildbox"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Lowercase letters, digits, dot or dash. Everything this machine reports is filed
                under this name.
              </p>
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="agent-step-up">Your password</Label>
            <Input
              id="agent-step-up"
              type="password"
              autoComplete="current-password"
              required
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
            />
          </div>

          {error && (
            <p role="alert" className="text-sm text-bad">
              {error}
            </p>
          )}

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant={pending.kind === 'revoke' ? 'destructive' : 'default'}
              disabled={busy}
            >
              {busy ? 'Working' : title}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function messageFor(error: unknown): string {
  if (!(error instanceof ApiError)) return 'Could not reach the server. Try again.';

  switch (error.code) {
    case 'reauthentication_failed':
      return 'That password is not right.';
    case 'invalid_name':
    case 'invalid_body':
      return 'That host name is not allowed. Lowercase letters, digits, dot or dash.';
    case 'not_found':
      return 'There is no token for that name any more.';
    default:
      return 'That did not work.';
  }
}
