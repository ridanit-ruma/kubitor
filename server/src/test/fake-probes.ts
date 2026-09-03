import type { ClusterProbes, WorkloadInfo } from '../plugins/contract.js';
import { ProbeDeniedError } from '../plugins/contract.js';

export interface FakeClusterState {
  crds?: readonly string[];
  workloads?: readonly (WorkloadInfo & { kind: string })[];
  services?: readonly string[];
  readyEndpoints?: readonly string[];
  ingressClasses?: readonly string[];
  storageClassProvisioners?: readonly string[];
  /** Probe names the caller is not permitted to perform. */
  denied?: readonly string[];
}

/**
 * A cluster that only exists in the test.
 *
 * Detection is the part of an integration most likely to be wrong, and it must
 * be testable without a Kubernetes API server for integrations to stay cheap to
 * contribute.
 */
export function fakeProbes(state: FakeClusterState = {}): ClusterProbes {
  const denied = new Set(state.denied ?? []);
  const deny = (what: string): void => {
    if (denied.has(what)) throw new ProbeDeniedError(what);
  };

  return {
    async hasCrd(name) {
      deny('crds');
      return (state.crds ?? []).includes(name);
    },
    async workload(kind, namespace, name) {
      deny('workloads');
      return (
        (state.workloads ?? []).find(
          (workload) =>
            workload.kind === kind && workload.namespace === namespace && workload.name === name,
        ) ?? null
      );
    },
    async service(namespace, name) {
      deny('services');
      return (state.services ?? []).includes(`${namespace}/${name}`);
    },
    async serviceHasReadyEndpoints(namespace, name) {
      deny('endpoints');
      return (state.readyEndpoints ?? []).includes(`${namespace}/${name}`);
    },
    async ingressClass(name) {
      deny('ingressclasses');
      return (state.ingressClasses ?? []).includes(name);
    },
    async storageClassProvisioners() {
      deny('storageclasses');
      return state.storageClassProvisioners ?? [];
    },
  };
}
