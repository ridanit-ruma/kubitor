'use client';

import type { BackupInput } from '@kubitor/shared';
import { SECRET_KEPT } from '@kubitor/shared';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
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
import { ApiError, api } from '@/lib/api';

const FIELDS: { name: keyof BackupInput['destination']; label: string; placeholder: string }[] = [
  { name: 'endpoint', label: 'Endpoint', placeholder: 'https://s3.eu-central-1.amazonaws.com' },
  { name: 'bucket', label: 'Bucket', placeholder: 'my-kubitor-backups' },
  { name: 'prefix', label: 'Prefix', placeholder: 'kubitor/' },
  { name: 'region', label: 'Region', placeholder: 'eu-central-1' },
  { name: 'accessKey', label: 'Access key ID', placeholder: 'AKIA...' },
  { name: 'secretKey', label: 'Secret access key', placeholder: '' },
];

/**
 * Where the database is copied to.
 *
 * Asks for the password on the way out, as running a backup by hand already
 * does: these are the same credentials, and moving where the database goes is
 * not the smaller of the two actions.
 */
export function DestinationDialog({
  open,
  onClose,
  onDone,
}: {
  open: boolean;
  onClose(): void;
  onDone(): Promise<void>;
}) {
  const [input, setInput] = useState<BackupInput | null>(null);
  const [canStoreSecrets, setCanStoreSecrets] = useState(true);
  const [currentPassword, setCurrentPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;

    void (async () => {
      const view = await api.backupSettings();
      const { canStoreSecrets: allowed, ...rest } = view;
      setCanStoreSecrets(allowed);
      setInput(rest);
      setError(null);
    })();
  }, [open]);

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (!input) return;

    setBusy(true);
    setError(null);

    try {
      const { changed } = await api.saveBackupSettings(input, currentPassword);
      toast.success(changed.length === 0 ? 'Nothing had changed.' : 'Destination saved.');
      setCurrentPassword('');
      await onDone();
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <form onSubmit={submit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>Backup destination</DialogTitle>
            <DialogDescription>
              Any S3-compatible store. Prefer somewhere the cluster does not depend on: a backup on
              storage served by the cluster it backs up survives none of the events backups exist
              for. Clear the bucket to turn backups off.
            </DialogDescription>
          </DialogHeader>

          {input && (
            <div className="space-y-3">
              {FIELDS.map((field) => {
                const value = input.destination[field.name] ?? '';
                const stored = field.name === 'secretKey' && value === SECRET_KEPT;

                return (
                  <div key={field.name} className="space-y-1.5">
                    <Label htmlFor={`destination-${field.name}`} className="text-xs">
                      {field.label}
                    </Label>
                    <Input
                      id={`destination-${field.name}`}
                      // Never `type="password"`: what somebody types here is a
                      // key they are pasting and need to be able to check, and
                      // the one thing that must not be readable — a stored
                      // secret — never reaches the browser at all.
                      value={stored ? '' : value}
                      placeholder={stored ? 'Stored. Type to replace it.' : field.placeholder}
                      disabled={field.name === 'secretKey' && !canStoreSecrets}
                      onChange={(event) =>
                        setInput((current) =>
                          current === null
                            ? current
                            : {
                                ...current,
                                destination: {
                                  ...current.destination,
                                  [field.name]: event.target.value,
                                },
                              },
                        )
                      }
                      className="font-mono text-xs"
                    />
                  </div>
                );
              })}

              <div className="space-y-1.5">
                <Label htmlFor="destination-schedule" className="text-xs">
                  Schedule
                </Label>
                <Input
                  id="destination-schedule"
                  value={input.schedule}
                  placeholder="17 3 * * *"
                  onChange={(event) =>
                    setInput((current) =>
                      current === null ? current : { ...current, schedule: event.target.value },
                    )
                  }
                  className="font-mono text-xs"
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="destination-recipient" className="text-xs">
                  Age recipient <span className="text-muted-foreground">(optional)</span>
                </Label>
                <Input
                  id="destination-recipient"
                  value={input.ageRecipient}
                  placeholder="age1..."
                  onChange={(event) =>
                    setInput((current) =>
                      current === null ? current : { ...current, ageRecipient: event.target.value },
                    )
                  }
                  className="font-mono text-xs"
                />
                <p className="text-xs text-muted-foreground">
                  With this and no identity, kubitor writes backups it cannot itself read. The
                  identity stays in the environment, because it is what opens the backup you would
                  restore from.
                </p>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="destination-password" className="text-xs">
                  Your password
                </Label>
                <Input
                  id="destination-password"
                  type="password"
                  autoComplete="current-password"
                  required
                  value={currentPassword}
                  onChange={(event) => setCurrentPassword(event.target.value)}
                />
              </div>
            </div>
          )}

          {error && (
            <p role="alert" className="text-sm text-bad">
              {error}
            </p>
          )}

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !input}>
              {busy ? 'Saving' : 'Save destination'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function messageFor(caught: unknown): string {
  if (!(caught instanceof ApiError)) return 'That did not work.';
  if (caught.code === 'reauthentication_failed') return 'That password is not right.';
  if (caught.code === 'settings_key_missing')
    return 'No KUBITOR_SETTINGS_KEY is set, so the secret key cannot be stored.';
  if (caught.code === 'invalid_settings')
    return 'Check the schedule and that the bucket has an endpoint, an access key and a secret key.';
  return 'That did not work.';
}
