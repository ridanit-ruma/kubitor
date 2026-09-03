'use client';

import type { CapabilityManifest, IntegrationStatus } from '@kubitor/shared';
import { AlertTriangle, Check, Minus } from 'lucide-react';
import Link from 'next/link';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

/**
 * What this cluster is.
 *
 * Every other dashboard opens with four statistics. kubitor opens by saying what
 * it can and cannot see, because that is what decides the shape of everything
 * below it — and because a monitoring tool that quietly shows nothing is worse
 * than one that says it is blind.
 */
export function CapabilityStrip({ manifest }: { manifest: CapabilityManifest }) {
  const present = manifest.integrations.filter((i) => i.state === 'present');
  const blind = manifest.integrations.filter((i) => i.state === 'unknown');
  const degraded = present.filter((i) => i.degraded.length > 0);

  return (
    <section
      aria-labelledby="capability-heading"
      className="rounded-lg border border-line bg-card px-4 py-3"
    >
      <div className="mb-3 flex items-baseline justify-between gap-4">
        <h2
          id="capability-heading"
          className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground"
        >
          What this cluster is
        </h2>
        <Link
          href="/settings"
          className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
        >
          Integrations
        </Link>
      </div>

      {manifest.integrations.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Nothing detected yet. kubitor probes the cluster every five minutes.
        </p>
      ) : (
        <ul className="flex flex-wrap gap-x-5 gap-y-2">
          {manifest.integrations.map((integration) => (
            <IntegrationChip key={integration.id} integration={integration} />
          ))}
        </ul>
      )}

      {(blind.length > 0 || degraded.length > 0) && (
        <p className="mt-3 border-t border-line pt-2 font-mono text-xs text-blind">
          {blind.length > 0 && `${blind.length} not readable`}
          {blind.length > 0 && degraded.length > 0 && ' · '}
          {degraded.length > 0 && `${degraded.length} installed but not reporting`}
        </p>
      )}
    </section>
  );
}

function IntegrationChip({ integration }: { integration: IntegrationStatus }) {
  const degraded = integration.state === 'present' && integration.degraded.length > 0;

  const tone = degraded
    ? 'text-blind'
    : integration.state === 'present'
      ? 'text-foreground'
      : integration.state === 'unknown'
        ? 'text-blind'
        : 'text-muted-foreground/50';

  return (
    <li>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className={cn('flex items-center gap-1.5 text-sm', tone)}>
            <StateMark state={integration.state} degraded={degraded} />
            <span className="font-medium">{integration.title}</span>
            {integration.version && (
              <span className="font-mono text-xs text-muted-foreground">{integration.version}</span>
            )}
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-sm">
          {/* Evidence in mono: it is a machine observation, not a sentence. */}
          <p className="font-mono text-xs">{integration.evidence}</p>
          {integration.degraded.map((reason) => (
            <p key={reason.facet} className="mt-1 font-mono text-xs text-blind">
              {reason.facet}: {reason.reason}
            </p>
          ))}
          {integration.override !== 'auto' && (
            <p className="mt-1 text-xs">Overridden to {integration.override.replace('_', ' ')}</p>
          )}
        </TooltipContent>
      </Tooltip>
    </li>
  );
}

function StateMark({ state, degraded }: { state: IntegrationStatus['state']; degraded: boolean }) {
  if (degraded || state === 'unknown') {
    return <AlertTriangle className="size-3.5" aria-label="not fully readable" />;
  }
  if (state === 'present') {
    return <Check className="size-3.5 text-good" aria-label="present" />;
  }
  return <Minus className="size-3.5" aria-label="absent" />;
}
