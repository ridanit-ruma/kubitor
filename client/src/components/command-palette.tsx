'use client';

import type { CapabilityManifest } from '@kubitor/shared';
import { Search } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { api } from '@/lib/api';

interface Hit {
  id: string;
  label: string;
  detail: string;
  href: string;
}

/**
 * Search is a primary way around this product, not a filter box.
 *
 * The palette reaches screens and rows alike: typing a node name goes to that
 * node, not to a filtered list the user then has to click through.
 */
export function CommandPalette({ manifest }: { manifest: CapabilityManifest | null }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [term, setTerm] = useState('');
  const [hits, setHits] = useState<Hit[]>([]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'k' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        setOpen((previous) => !previous);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (!open || term.trim().length < 2) {
      setHits([]);
      return;
    }

    let cancelled = false;
    const timer = setTimeout(async () => {
      const found = await search(term);
      if (!cancelled) setHits(found);
    }, 150);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [open, term]);

  const go = (href: string): void => {
    setOpen(false);
    setTerm('');
    router.push(href);
  };

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        className="text-muted-foreground"
        onClick={() => setOpen(true)}
      >
        <Search className="size-4" />
        <span className="hidden sm:inline">Search</span>
        <kbd className="ml-2 hidden font-mono text-[10px] text-muted-foreground sm:inline">⌘K</kbd>
      </Button>

      <CommandDialog open={open} onOpenChange={setOpen}>
        <CommandInput
          placeholder="Find a node, workload, namespace or route"
          value={term}
          onValueChange={setTerm}
        />
        <CommandList>
          <CommandEmpty>
            {term.trim().length < 2 ? 'Type at least two characters.' : 'Nothing matched.'}
          </CommandEmpty>

          {hits.length > 0 && (
            <CommandGroup heading="Results">
              {hits.map((hit) => (
                <CommandItem
                  key={hit.id}
                  value={`${hit.label} ${hit.detail}`}
                  onSelect={() => go(hit.href)}
                >
                  <span>{hit.label}</span>
                  <span className="ml-auto font-mono text-xs text-muted-foreground">
                    {hit.detail}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          )}

          {manifest && (
            <CommandGroup heading="Screens">
              {manifest.nav
                .filter((entry) => entry.title.toLowerCase().includes(term.toLowerCase()))
                .map((entry) => (
                  <CommandItem
                    key={entry.id}
                    value={`nav-${entry.id}`}
                    onSelect={() => go(entry.href)}
                  >
                    {entry.title}
                  </CommandItem>
                ))}
            </CommandGroup>
          )}
        </CommandList>
      </CommandDialog>
    </>
  );
}

async function search(term: string): Promise<Hit[]> {
  const query = new URLSearchParams({ search: term, limit: '5' });

  const [nodes, workloads, routes] = await Promise.allSettled([
    api.facet('nodes', query),
    api.facet('workloads', query),
    api.facet('routes', query),
  ]);

  const hits: Hit[] = [];

  if (nodes.status === 'fulfilled') {
    for (const row of nodes.value.rows) {
      hits.push({
        id: `node-${String(row.name)}`,
        label: String(row.name),
        detail: 'node',
        href: `/nodes/${encodeURIComponent(String(row.name))}`,
      });
    }
  }

  if (workloads.status === 'fulfilled') {
    for (const row of workloads.value.rows) {
      hits.push({
        id: `pod-${String(row.namespace)}-${String(row.name)}`,
        label: String(row.name),
        detail: String(row.namespace),
        href: `/workloads?namespace=${encodeURIComponent(String(row.namespace))}&search=${encodeURIComponent(String(row.name))}`,
      });
    }
  }

  if (routes.status === 'fulfilled') {
    for (const row of routes.value.rows) {
      hits.push({
        id: `route-${String(row.namespace)}-${String(row.name)}-${String(row.path)}`,
        label: `${String(row.host)}${String(row.path)}`,
        detail: 'route',
        href: `/routes?search=${encodeURIComponent(String(row.host))}`,
      });
    }
  }

  return hits;
}
