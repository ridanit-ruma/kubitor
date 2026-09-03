import type { ClusterProbes } from '../contract.js';

/**
 * Probes for a server with no Kubernetes access.
 *
 * Every question fails rather than answering "no", so detection reports
 * `unknown` with a readable reason instead of telling the operator they do not
 * run software they do run. Plan 4 replaces this with the real client.
 */
export function unavailableProbes(): ClusterProbes {
  const fail = (): never => {
    throw new Error('Kubernetes access is not configured');
  };

  return {
    hasCrd: fail,
    workload: fail,
    service: fail,
    serviceHasReadyEndpoints: fail,
    ingressClass: fail,
    storageClassProvisioners: fail,
  };
}
