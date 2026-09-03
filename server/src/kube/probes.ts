import type { ClusterProbes } from '../plugins/contract.js';
import type { KubeApi } from './api.js';

/**
 * `ClusterProbes` over `KubeApi`.
 *
 * Deliberately thin: the interesting behaviour — turning a 403 into
 * `ProbeDeniedError` — lives in the client, so this stays a rename.
 */
export function clusterProbes(api: KubeApi): ClusterProbes {
  return {
    hasCrd: (name) => api.hasCrd(name),
    workload: (kind, namespace, name) => api.workload(kind, namespace, name),
    service: (namespace, name) => api.service(namespace, name),
    serviceHasReadyEndpoints: (namespace, name) => api.serviceHasReadyEndpoints(namespace, name),
    ingressClass: (name) => api.ingressClass(name),
    storageClassProvisioners: () => api.storageClassProvisioners(),
  };
}
