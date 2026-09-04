'use client';

import { ArrowLeft, KeyRound, Trash2, UserPlus } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
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
import { type AccountSummary, ApiError, api } from '@/lib/api';
import { formatTimestamp } from '@/lib/format';

type Pending =
  | { kind: 'create' }
  | { kind: 'reset'; account: AccountSummary }
  | { kind: 'delete'; account: AccountSummary };

export default function AccountsPage() {
  const [accounts, setAccounts] = useState<AccountSummary[]>([]);
  const [pending, setPending] = useState<Pending | null>(null);
  const [issued, setIssued] = useState<{ username: string; password: string } | null>(null);

  const load = useCallback(async () => {
    setAccounts((await api.accounts()).accounts);
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
        <h1 className="text-lg font-semibold tracking-tight">Accounts</h1>
        <Button size="sm" className="ml-auto" onClick={() => setPending({ kind: 'create' })}>
          <UserPlus className="size-3.5" />
          Add account
        </Button>
      </div>

      <p className="max-w-2xl text-sm text-muted-foreground">
        Every change here asks for your own password again, so a borrowed session is not enough to
        mint a way in. Keep a second account: losing the only one means losing the dashboard.
      </p>

      <div className="pane rounded-lg border border-line">
        <Table className="table-fixed">
          <TableHeader className="sticky top-0 z-10 bg-card">
            <TableRow>
              <TableHead className="truncate font-mono text-[11px] uppercase tracking-[0.1em]">
                Username
              </TableHead>
              <TableHead className="w-[34%] truncate font-mono text-[11px] uppercase tracking-[0.1em] sm:w-[22%]">
                State
              </TableHead>
              <TableHead className="hidden w-[22%] truncate font-mono text-[11px] uppercase tracking-[0.1em] md:table-cell">
                Created
              </TableHead>
              <TableHead className="w-[26%] truncate text-right font-mono text-[11px] uppercase tracking-[0.1em] lg:w-[34%]">
                Actions
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {accounts.map((account) => (
              <TableRow key={account.id}>
                <TableCell className="max-w-0 truncate font-medium">{account.username}</TableCell>
                <TableCell className="max-w-0 truncate">
                  {account.mustChangePassword ? (
                    <Badge variant="outline" className="border-blind text-blind">
                      Password not set
                    </Badge>
                  ) : (
                    <Badge variant="secondary">Active</Badge>
                  )}
                </TableCell>
                <TableCell className="hidden max-w-0 truncate font-mono text-xs text-muted-foreground md:table-cell">
                  {formatTimestamp(account.createdAt)}
                </TableCell>
                <TableCell className="text-right">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setPending({ kind: 'reset', account })}
                  >
                    <KeyRound className="size-3.5" />
                    <span className="sr-only lg:not-sr-only">Reset password</span>
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setPending({ kind: 'delete', account })}
                  >
                    <Trash2 className="size-3.5" />
                    <span className="sr-only lg:not-sr-only">Delete</span>
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <StepUpDialog
        key={
          pending === null
            ? 'none'
            : `${pending.kind}-${pending.kind === 'create' ? '' : pending.account.id}`
        }
        pending={pending}
        onClose={() => setPending(null)}
        onDone={async (result) => {
          setPending(null);
          if (result) setIssued(result);
          await load();
        }}
      />

      <Dialog open={issued !== null} onOpenChange={() => setIssued(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>One-time password for {issued?.username}</DialogTitle>
            <DialogDescription>
              This is shown once and is not stored anywhere in readable form. The account must
              change it at first sign-in.
            </DialogDescription>
          </DialogHeader>
          <p className="rounded border border-line bg-muted px-3 py-2 font-mono text-sm break-all">
            {issued?.password}
          </p>
          <DialogFooter>
            <Button onClick={() => setIssued(null)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function StepUpDialog({
  pending,
  onClose,
  onDone,
}: {
  pending: Pending | null;
  onClose(): void;
  onDone(result: { username: string; password: string } | null): Promise<void>;
}) {
  const [username, setUsername] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Remounted by its key whenever the target changes, so the fields start empty
  // without an effect that has to remember to clear them.
  if (!pending) return null;

  const titles = {
    create: 'Add an account',
    reset: `Reset ${pending.kind === 'create' ? '' : pending.account.username}`,
    delete: `Delete ${pending.kind === 'create' ? '' : pending.account.username}`,
  } as const;

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      if (pending.kind === 'create') {
        const created = await api.createAccount(username, currentPassword);
        await onDone({ username: created.account.username, password: created.password });
      } else if (pending.kind === 'reset') {
        const reset = await api.resetAccount(pending.account.id, currentPassword);
        await onDone({ username: pending.account.username, password: reset.password });
      } else {
        await api.deleteAccount(pending.account.id, currentPassword);
        toast.success(`Deleted ${pending.account.username}.`);
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
            <DialogTitle>{titles[pending.kind]}</DialogTitle>
            <DialogDescription>
              {pending.kind === 'reset' && 'This signs the account out everywhere.'}
              {pending.kind === 'delete' && 'This cannot be undone.'}
              {pending.kind === 'create' &&
                'kubitor generates the first password and shows it once.'}
            </DialogDescription>
          </DialogHeader>

          {pending.kind === 'create' && (
            <div className="space-y-2">
              <Label htmlFor="new-username">Username</Label>
              <Input
                id="new-username"
                autoFocus
                required
                pattern="[a-z0-9][a-z0-9._\-]*"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Lowercase letters, digits, dot, dash or underscore.
              </p>
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="step-up">Your password</Label>
            <Input
              id="step-up"
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
              variant={pending.kind === 'delete' ? 'destructive' : 'default'}
              disabled={busy}
            >
              {busy ? 'Working' : titles[pending.kind]}
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
    case 'username_taken':
      return 'An account with that name already exists.';
    case 'self':
      return 'You cannot delete the account you are signed in as.';
    case 'invalid_body':
      return 'That username is not allowed.';
    default:
      return 'That did not work.';
  }
}
