'use client';

import type { NotifyInput } from '@kubitor/shared';
import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ApiError, api } from '@/lib/api';
import { CHANNELS, type ChannelKey, isConfigured, toInput } from '@/lib/notify-form';
import { ChannelCard } from './channel-card';

/**
 * Where alerts go.
 *
 * One screen rather than a row per channel on a list, because the question
 * somebody arrives with is "is anybody being told, and would it get through" —
 * and that is answered by seeing every channel's state at once, next to a
 * button that proves it.
 */
export default function NotificationsPage() {
  const [saved, setSaved] = useState<NotifyInput | null>(null);
  const [draft, setDraft] = useState<NotifyInput | null>(null);
  const [canStoreSecrets, setCanStoreSecrets] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const view = await api.notifySettings();
    setCanStoreSecrets(view.canStoreSecrets);
    setSaved(toInput(view));
    setDraft(toInput(view));
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const dirty = draft !== null && saved !== null && JSON.stringify(draft) !== JSON.stringify(saved);

  // The cast is load-bearing: a computed key over a union of channel shapes
  // widens past `NotifyInput`, and the alternative is seven near-identical
  // setters. The shape is guaranteed by `CHANNELS` covering exactly these keys,
  // which `notify-form.test.ts` asserts.
  const edit = (key: ChannelKey, field: string, value: string): void => {
    setDraft((current) => {
      if (current === null) return current;

      const channel = { ...(current[key] as Record<string, string | null>), [field]: value };
      return { ...current, [key]: channel } as NotifyInput;
    });
  };

  const save = async (): Promise<void> => {
    if (!draft) return;
    setBusy(true);

    try {
      const { changed } = await api.saveNotifySettings(draft);
      toast.success(
        changed.length === 0 ? 'Nothing had changed.' : `Saved ${changed.length} change(s).`,
      );
      await load();
    } catch (caught) {
      toast.error(messageFor(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="screen gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <Button asChild variant="ghost" size="sm">
          <Link href="/settings">
            <ArrowLeft className="size-4" />
            Integrations
          </Link>
        </Button>
        <h1 className="text-base font-semibold tracking-tight">Notifications</h1>
        <Button size="sm" className="ml-auto" disabled={!dirty || busy} onClick={() => void save()}>
          {busy ? 'Saving' : 'Save changes'}
        </Button>
      </div>

      <div className="pane flex flex-col gap-4 pr-1">
        {!canStoreSecrets && (
          <p className="max-w-3xl rounded-lg border border-line p-3 text-sm text-muted-foreground">
            No <code className="font-mono text-xs">KUBITOR_SETTINGS_KEY</code> is set, so a webhook
            URL or token cannot be stored — it would sit in the clear in the database, and in every
            backup of it. Generate an identity with{' '}
            <code className="font-mono text-xs">age-keygen</code> and set it on the Deployment. The
            severity floor below is editable either way.
          </p>
        )}

        {draft && (
          <div className="flex max-w-3xl flex-col gap-1.5">
            <Label htmlFor="minimum-severity" className="text-xs">
              Send nothing quieter than
            </Label>
            <Select
              value={draft.minimumSeverity}
              onValueChange={(value) =>
                setDraft((current) =>
                  current === null
                    ? current
                    : { ...current, minimumSeverity: value as 'critical' | 'warning' },
                )
              }
            >
              <SelectTrigger id="minimum-severity" className="w-full sm:w-64">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="warning">Warning — everything there is</SelectItem>
                <SelectItem value="critical">Critical only</SelectItem>
              </SelectContent>
            </Select>
          </div>
        )}

        {draft && (
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2 xl:grid-cols-3">
            {CHANNELS.map((channel) => (
              <ChannelCard
                key={channel.key}
                channel={channel}
                values={draft[channel.key] as Record<string, string | null>}
                configured={isConfigured(draft, channel.key)}
                canStoreSecrets={canStoreSecrets}
                dirty={dirty}
                onChange={(field, value) => edit(channel.key, field, value)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function messageFor(caught: unknown): string {
  if (!(caught instanceof ApiError)) return 'That did not work.';
  if (caught.code === 'settings_key_missing')
    return 'No KUBITOR_SETTINGS_KEY is set, so that secret cannot be stored.';
  if (caught.code === 'invalid_settings') return 'A channel is missing one of the fields it needs.';
  return 'That did not work.';
}
