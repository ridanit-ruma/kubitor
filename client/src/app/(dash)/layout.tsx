'use client';

import type { CapabilityManifest } from '@kubitor/shared';
import { LogOut } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { AppSidebar } from '@/components/app-sidebar';
import { CommandPalette } from '@/components/command-palette';
import { Button } from '@/components/ui/button';
import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ApiError, api } from '@/lib/api';
import { ManifestContext } from '@/lib/manifest-context';

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [manifest, setManifest] = useState<CapabilityManifest | null>(null);
  const [ready, setReady] = useState(false);

  const load = useCallback(async () => {
    try {
      const session = await api.me();
      // Enforced by the server too; this only spares the user a wall of 403s.
      if (session.mustChangePassword) {
        router.replace('/change-password');
        return;
      }
      setManifest(await api.capabilities());
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        router.replace('/login');
        return;
      }
      throw error;
    } finally {
      setReady(true);
    }
  }, [router]);

  useEffect(() => {
    void load();
  }, [load]);

  const signOut = async (): Promise<void> => {
    await api.logout();
    router.replace('/login');
  };

  return (
    <TooltipProvider delayDuration={200}>
      <ManifestContext.Provider value={{ manifest, refresh: load }}>
        <SidebarProvider>
          <AppSidebar manifest={manifest} />
          <SidebarInset className="flex h-screen flex-col overflow-hidden">
            <header className="flex h-12 shrink-0 items-center gap-3 border-b border-line px-3">
              <SidebarTrigger />
              <CommandPalette manifest={manifest} />
              <div className="ml-auto flex items-center gap-3">
                {manifest && (
                  <span className="hidden font-mono text-xs text-muted-foreground sm:inline">
                    {manifest.cluster.nodes} nodes
                  </span>
                )}
                <Button variant="ghost" size="sm" onClick={() => void signOut()}>
                  <LogOut className="size-4" />
                  <span className="sr-only sm:not-sr-only">Sign out</span>
                </Button>
              </div>
            </header>

            {/* The page never scrolls; whatever is inside it does. */}
            <main className="min-h-0 flex-1 overflow-hidden p-4">{ready ? children : null}</main>
          </SidebarInset>
        </SidebarProvider>
      </ManifestContext.Provider>
    </TooltipProvider>
  );
}
