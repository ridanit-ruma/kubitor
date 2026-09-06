'use client';

import { ArrowLeft, Play } from 'lucide-react';
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
import { ApiError, api, type BackupStatus } from '@/lib/api';
import { formatBytes, formatTimestamp } from '@/lib/format';
import { useNow } from '@/lib/live';

/** What each encryption mode actually means for the bucket. */
const ENCRYPTION: Record<string, { label: string; detail: string }> = {
  none: {
    label: 'Not encrypted here',
    detail:
      'Anyone who can read the bucket can read the database. Set KUBITOR_BACKUP_AGE_RECIPIENT, or turn on the bucket\u2019s own encryption.',
  },
  'write-only': {
    label: 'Encrypted, unreadable here',
    detail:
      'kubitor holds the recipient and no identity, so it cannot read back what it wrote \u2014 a compromised server yields ciphertext. Verification compares the bytes in the bucket against what was sent; opening the database happens at restore.',
  },
  readable: {
    label: 'Encrypted, readable here',
    detail:
      'The identity is configured alongside the recipient, so each backup is opened and integrity-checked after upload. The cost is that a compromised server can decrypt its own history.',
  },
};

/**
 * Whether there is a backup, how old it is, and what happened to the ones
 * before it.
 *
 * The age of the newest *verified* backup is the headline, because a backup
 * feature that silently stopped six weeks ago is the failure this exists to
 * prevent, and "we uploaded something" is not the same as "there is a database
 * in the bucket".
 */
export default function BackupsPage() {
  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [asking, setAsking] = useState(false);
  const now = useNow();

  const load = useCallback(async () => {
    setStatus(await api.backups());
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
        <h1 className="text-base font-semibold tracking-tight">Backups</h1>
        {status?.configured && (
          <Button size="sm" className="ml-auto" onClick={() => setAsking(true)}>
            <Play className="size-3.5" />
            Back up now
          </Button>
        )}
      </div>

      {status !== null && !status.configured && <NotConfigured />}

      {status?.configured && (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Fact label="Newest verified">
              <Age sampledAt={status.newestVerifiedAt} now={now} staleAfterMs={36 * 3_600_000} />
            </Fact>
            <Fact label="Bucket">
              <span className="font-mono text-xs break-all">{status.bucket}</span>
            </Fact>
            <Fact label="Schedule">
              <span className="font-mono text-xs">{status.schedule}</span>
              <span className="text-xs text-muted-foreground">
                next {status.nextRunAt === null ? 'never' : formatTimestamp(status.nextRunAt)}
              </span>
            </Fact>
            <Fact label="Encryption">
              <Badge variant={status.encryption === 'none' ? 'outline' : 'secondary'}>
                {ENCRYPTION[status.encryption]?.label ?? status.encryption}
              </Badge>
            </Fact>
          </div>

          <p className="max-w-3xl text-sm text-muted-foreground">
            {ENCRYPTION[status.encryption]?.detail}
          </p>

          <div className="pane rounded-lg border border-line">
            <Table className="table-fixed">
              <TableHeader className="sticky top-0 z-10 bg-card">
                <TableRow>
                  <TableHead className="w-[22%] truncate font-mono text-[11px] uppercase tracking-[0.1em]">
                    Started
                  </TableHead>
                  <TableHead className="w-[18%] truncate font-mono text-[11px] uppercase tracking-[0.1em]">
                    Outcome
                  </TableHead>
                  <TableHead className="hidden w-[12%] truncate text-right font-mono text-[11px] uppercase tracking-[0.1em] sm:table-cell">
                    Size
                  </TableHead>
                  <TableHead className="truncate font-mono text-[11px] uppercase tracking-[0.1em]">
                    Object, or why not
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {status.backups.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={4} className="py-8 text-center text-muted-foreground">
                      Nothing has run yet. The first one goes at {status.schedule}.
                    </TableCell>
                  </TableRow>
                )}

                {status.backups.map((backup) => (
                  <TableRow key={backup.id}>
                    <TableCell className="max-w-0 truncate font-mono text-xs">
                      {formatTimestamp(backup.startedAt)}
                    </TableCell>
                    <TableCell className="max-w-0 truncate">
                      {backup.ok && backup.verified ? (
                        <Badge variant="secondary">Verified</Badge>
                      ) : backup.finishedAt === null ? (
                        <Badge variant="outline">Running</Badge>
                      ) : (
                        <Badge variant="destructive">Failed</Badge>
                      )}
                    </TableCell>
                    <TableCell className="hidden max-w-0 truncate text-right tabular sm:table-cell">
                      {formatBytes(backup.bytes)}
                    </TableCell>
                    <TableCell className="max-w-0 truncate font-mono text-xs text-muted-foreground">
                      {backup.error ?? backup.key ?? '\u2014'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </>
      )}

      <RunDialog
        open={asking}
        onClose={() => setAsking(false)}
        onDone={async () => {
          setAsking(false);
          await load();
        }}
      />
    </div>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-line p-3">
      <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
        {label}
      </span>
      {children}
    </div>
  );
}

function NotConfigured() {
  return (
    <div className="max-w-3xl space-y-3 rounded-lg border border-line p-4">
      <p className="text-sm">
        No bucket is configured, so nothing is being backed up. kubitor keeps its accounts, agent
        credentials, integration settings and history in one database; losing the volume loses all
        of it.
      </p>
      <pre className="overflow-x-auto rounded border border-line bg-muted px-3 py-2 font-mono text-xs">
        {`KUBITOR_BACKUP_S3_ENDPOINT=https://s3.eu-central-1.amazonaws.com
KUBITOR_BACKUP_S3_BUCKET=my-kubitor-backups
KUBITOR_BACKUP_S3_ACCESS_KEY=...
KUBITOR_BACKUP_S3_SECRET_KEY=...
KUBITOR_BACKUP_AGE_RECIPIENT=age1...   # optional, and recommended`}
      </pre>
      <p className="text-sm text-muted-foreground">
        Works with any S3-compatible store \u2014 AWS, MinIO, Backblaze B2, Cloudflare R2, Ceph RGW.
        Prefer somewhere the cluster does not depend on: a backup on storage served by the cluster
        it backs up survives none of the events backups exist for.
      </p>
      <p className="text-sm text-muted-foreground">
        Running PostgreSQL? kubitor does not back that up \u2014 use your database\u2019s own backup
        rather than a second, worse one here.
      </p>
    </div>
  );
}

function RunDialog({
  open,
  onClose,
  onDone,
}: {
  open: boolean;
  onClose(): void;
  onDone(): Promise<void>;
}) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      const result = await api.runBackup(currentPassword);
      if (result.ok) toast.success(`Backed up and verified: ${result.key}`);
      else toast.error(`Backup failed: ${result.error}`);
      setCurrentPassword('');
      await onDone();
    } catch (caught) {
      setError(
        caught instanceof ApiError && caught.code === 'reauthentication_failed'
          ? 'That password is not right.'
          : 'That did not work.',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent>
        <form onSubmit={submit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>Back up now</DialogTitle>
            <DialogDescription>
              Takes a snapshot, uploads it and reads it back to check it. This can take a while on a
              large database, and the schedule is unaffected.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-2">
            <Label htmlFor="backup-step-up">Your password</Label>
            <Input
              id="backup-step-up"
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
            <Button type="submit" disabled={busy}>
              {busy ? 'Working' : 'Back up now'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
