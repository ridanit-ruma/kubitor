'use client';

import type { CapabilityManifest, NavCategory, NavEntry } from '@kubitor/shared';
import {
  Activity,
  Boxes,
  Cpu,
  FileClock,
  GitBranch,
  HardDrive,
  Layers,
  type LucideIcon,
  Network,
  Route,
  Server,
  Settings,
  ShieldAlert,
  Users,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar';

/** Fixed order; only the entries inside come and go. */
const CATEGORY_LABELS: Record<NavCategory, string> = {
  overview: '',
  infrastructure: 'Infrastructure',
  network: 'Network',
  storage: 'Storage',
  delivery: 'Delivery',
  hosts: 'Hosts',
  security: 'Security',
  settings: 'Settings',
};

const CATEGORY_ORDER: NavCategory[] = [
  'overview',
  'infrastructure',
  'network',
  'storage',
  'delivery',
  'hosts',
  'security',
  'settings',
];

const ICONS: Record<string, LucideIcon> = {
  overview: Activity,
  nodes: Server,
  workloads: Boxes,
  namespaces: Layers,
  events: FileClock,
  'http-traffic': Network,
  routes: Route,
  certificates: ShieldAlert,
  volumes: HardDrive,
  gitops: GitBranch,
  hardware: Cpu,
  alerts: ShieldAlert,
  integrations: Settings,
  accounts: Users,
};

/**
 * The navigation is a function of the cluster.
 *
 * Bare k3s gets ten entries across four categories; a cluster running Traefik,
 * Cilium and Rook gets roughly twice that. Nothing here is hardcoded — the
 * server decides, and the client only knows how to draw what it is told.
 */
export function AppSidebar({ manifest }: { manifest: CapabilityManifest | null }) {
  const pathname = usePathname();
  const entries = manifest?.nav ?? [];
  const active = activeHref(entries, pathname);

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="px-3 py-4">
        <Link href="/" className="flex items-baseline gap-2">
          <span className="text-lg font-semibold tracking-tight">kubitor</span>
          {manifest && (
            // kubitor's own build. The cluster's version belongs to the cluster,
            // and printing it here made it read as the product's.
            <span className="font-mono text-[11px] text-muted-foreground">
              {shortVersion(manifest.kubitor.version)}
            </span>
          )}
        </Link>
      </SidebarHeader>

      <SidebarContent>
        {CATEGORY_ORDER.map((category) => {
          const inCategory = entries.filter((entry) => entry.category === category);
          if (inCategory.length === 0) return null;

          return (
            <SidebarGroup key={category}>
              {CATEGORY_LABELS[category] && (
                <SidebarGroupLabel className="font-mono text-[10px] uppercase tracking-[0.14em]">
                  {CATEGORY_LABELS[category]}
                </SidebarGroupLabel>
              )}
              <SidebarGroupContent>
                <SidebarMenu>
                  {inCategory.map((entry) => (
                    <NavRow key={entry.id} entry={entry} active={entry.href === active} />
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          );
        })}
      </SidebarContent>
    </Sidebar>
  );
}

/**
 * The one entry the current path belongs to.
 *
 * Longest match wins, and a match must end at a path segment. Both matter:
 * `/settings/accounts` starts with `/settings`, so a plain prefix test lit up
 * two rows at once and left the reader unsure which screen they were on.
 */
function activeHref(entries: readonly NavEntry[], pathname: string): string | null {
  let best: string | null = null;

  for (const entry of entries) {
    const matches =
      entry.href === '/'
        ? pathname === '/'
        : pathname === entry.href || pathname.startsWith(`${entry.href}/`);

    if (matches && (best === null || entry.href.length > best.length)) best = entry.href;
  }

  return best;
}

/** A commit is identified by its first characters; the rest is noise in a header. */
function shortVersion(version: string): string {
  return /^[0-9a-f]{40}$/.test(version) ? version.slice(0, 7) : version;
}

function NavRow({ entry, active }: { entry: NavEntry; active: boolean }) {
  const Icon = ICONS[entry.id] ?? Activity;

  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild isActive={active} tooltip={entry.title}>
        <Link href={entry.href}>
          <Icon className="size-4" />
          <span>{entry.title}</span>
        </Link>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}
