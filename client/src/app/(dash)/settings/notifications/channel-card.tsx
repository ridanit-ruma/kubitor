'use client';

import { Send } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { api } from '@/lib/api';
import { type ChannelDescriptor, SECRET_KEPT } from '@/lib/notify-form';

export interface ChannelCardProps {
  channel: ChannelDescriptor;
  values: Record<string, string | null>;
  configured: boolean;
  canStoreSecrets: boolean;
  /** True while there are unsaved edits, which is when a test would lie. */
  dirty: boolean;
  onChange(field: string, value: string): void;
}

/**
 * One channel: what it needs, whether it is on, and proof that it works.
 *
 * The test button is the reason this is a card rather than a row. A webhook URL
 * that is wrong fails silently at 3am, and the only honest way to offer this
 * form is to let somebody prove the value before they walk away from it.
 */
export function ChannelCard({
  channel,
  values,
  configured,
  canStoreSecrets,
  dirty,
  onChange,
}: ChannelCardProps) {
  const [testing, setTesting] = useState(false);

  const test = async (): Promise<void> => {
    setTesting(true);
    try {
      const result = await api.testNotifyChannel(channel.id);
      if (result.ok) toast.success(`${channel.title} received it.`);
      else toast.error(`${channel.title} did not: ${result.error}`);
    } catch {
      toast.error('That did not work.');
    } finally {
      setTesting(false);
    }
  };

  const testDisabledReason = dirty
    ? 'Save first — a test sends what is stored, not what is typed.'
    : !configured
      ? 'Fill in the required fields and save before testing.'
      : undefined;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          {channel.title}
          {configured ? (
            <Badge variant="secondary">On</Badge>
          ) : (
            <Badge variant="outline">Off</Badge>
          )}
        </CardTitle>
        <CardDescription>{channel.hint}</CardDescription>
      </CardHeader>

      <CardContent className="space-y-3">
        {channel.fields.map((field) => {
          const id = `${channel.key}-${field.name}`;
          const value = values[field.name] ?? '';
          const stored = field.secret && value === SECRET_KEPT;

          return (
            <div key={field.name} className="space-y-1.5">
              <Label htmlFor={id} className="text-xs">
                {field.label}
                {!field.required && <span className="ml-1 text-muted-foreground">(optional)</span>}
              </Label>
              <Input
                id={id}
                // Never `type="password"`: the value here is a URL or a token
                // that somebody is pasting and needs to be able to check, and
                // the one thing that must not be readable — a stored secret —
                // never reaches the browser at all.
                value={stored ? '' : value}
                placeholder={stored ? 'Stored. Type to replace it.' : field.placeholder}
                disabled={field.secret && !canStoreSecrets}
                onChange={(event) => onChange(field.name, event.target.value)}
                className="font-mono text-xs"
              />
            </div>
          );
        })}
      </CardContent>

      <CardFooter>
        <Button
          variant="outline"
          size="sm"
          disabled={!configured || dirty || testing}
          onClick={() => void test()}
          title={testDisabledReason}
        >
          <Send className="size-3.5" />
          {testing ? 'Sending' : 'Send a test'}
        </Button>
      </CardFooter>
    </Card>
  );
}
