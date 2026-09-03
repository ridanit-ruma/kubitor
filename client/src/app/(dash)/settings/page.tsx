'use client';

import type { IntegrationStatus } from '@kubitor/shared';
import { RefreshCw } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { api } from '@/lib/api';
import { useManifest } from '@/lib/manifest-context';

/**
 * Where the plugin architecture becomes something the operator can see.
 *
 * Each row states what kubitor concluded, the evidence it concluded it from, and
 * lets that conclusion be overruled. Detection is a default, not a cage — and an
 * operator who disagrees should not have to guess what the tool was looking at.
 */
export default function IntegrationsPage() {
  const { manifest, refresh } = useManifest();
  const [scanning, setScanning] = useState(false);

  const rescan = async (): Promise<void> => {
    setScanning(true);
    try {
      await api.rescan();
      await refresh();
      toast.success('Rescanned the cluster.');
    } finally {
      setScanning(false);
    }
  };

  const setOverride = async (
    id: string,
    override: 'auto' | 'force_on' | 'force_off',
  ): Promise<void> => {
    await api.setOverride(id, override);
    await refresh();
  };

  return (
    <div className="screen gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold tracking-tight">Integrations</h1>
        <Link
          href="/settings/accounts"
          className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
        >
          Accounts
        </Link>
        <Button
          variant="outline"
          size="sm"
          className="ml-auto"
          onClick={() => void rescan()}
          disabled={scanning}
        >
          <RefreshCw className="size-3.5" />
          {scanning ? 'Scanning' : 'Rescan'}
        </Button>
      </div>

      <p className="max-w-2xl text-sm text-muted-foreground">
        kubitor probes the cluster every five minutes and shows the screens that match what it
        finds. Where it cannot read something, it says so rather than reporting an empty graph.
      </p>

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto">
        {(manifest?.integrations ?? []).map((integration) => (
          <IntegrationRow
            key={integration.id}
            integration={integration}
            onOverride={(value) => void setOverride(integration.id, value)}
          />
        ))}

        {manifest?.integrations.length === 0 && (
          <p className="rounded-lg border border-line bg-card p-6 text-center text-sm text-muted-foreground">
            No integration is registered in this build.
          </p>
        )}
      </div>
    </div>
  );
}

function IntegrationRow({
  integration,
  onOverride,
}: {
  integration: IntegrationStatus;
  onOverride(value: 'auto' | 'force_on' | 'force_off'): void;
}) {
  return (
    <article className="rounded-lg border border-line bg-card p-4">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="font-medium">{integration.title}</h2>
        <StateBadge integration={integration} />
        {integration.version && (
          <span className="font-mono text-xs text-muted-foreground">{integration.version}</span>
        )}
        <span className="font-mono text-[11px] uppercase tracking-[0.1em] text-muted-foreground">
          {integration.scope}
        </span>

        <Select value={integration.override} onValueChange={onOverride}>
          <SelectTrigger className="ml-auto h-8 w-40" size="sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="auto">Detect automatically</SelectItem>
            <SelectItem value="force_on">Always on</SelectItem>
            <SelectItem value="force_off">Always off</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* The evidence is the point of this screen. */}
      <p className="mt-2 font-mono text-xs text-muted-foreground">{integration.evidence}</p>

      {integration.unknownReason === 'rbac' && (
        <p className="mt-1 text-xs text-blind">
          kubitor is not permitted to run this probe. Grant the read access it needs, or set this
          integration to always on if you know it is there.
        </p>
      )}

      {integration.degraded.map((reason) => (
        <p key={reason.facet} className="mt-1 font-mono text-xs text-blind">
          {reason.facet}: {reason.reason}
        </p>
      ))}

      {integration.facets.length > 0 && (
        <p className="mt-2 flex flex-wrap gap-1.5">
          {integration.facets.map((facet) => (
            <span
              key={facet}
              className="rounded border border-line px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
            >
              {facet}
            </span>
          ))}
        </p>
      )}
    </article>
  );
}

function StateBadge({ integration }: { integration: IntegrationStatus }) {
  if (integration.state === 'present') {
    return integration.degraded.length > 0 ? (
      <Badge variant="outline" className="border-blind text-blind">
        Present, not reporting
      </Badge>
    ) : (
      <Badge variant="secondary">Present</Badge>
    );
  }

  if (integration.state === 'unknown') {
    return (
      <Badge variant="outline" className="border-blind text-blind">
        Cannot tell
      </Badge>
    );
  }

  return <Badge variant="outline">Not installed</Badge>;
}
