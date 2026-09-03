'use client';

import type { CapabilityManifest } from '@kubitor/shared';
import { createContext, useContext } from 'react';

interface ManifestValue {
  manifest: CapabilityManifest | null;
  refresh(): Promise<void>;
}

export const ManifestContext = createContext<ManifestValue>({
  manifest: null,
  refresh: async () => undefined,
});

export function useManifest(): ManifestValue {
  return useContext(ManifestContext);
}
