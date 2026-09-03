import type { IntegrationOverride } from '@kubitor/shared';
import type { IntegrationStateRepo } from '../db/integration-state.repo.js';
import type { ClusterProbes, Detection, IntegrationModule } from './contract.js';
import { ProbeDeniedError } from './contract.js';
import type { IntegrationRegistry } from './registry.js';

export interface DetectionDeps {
  registry: IntegrationRegistry;
  states: IntegrationStateRepo;
  probes: ClusterProbes;
}

/** How often the cluster is re-probed; installing Rook should show up by itself. */
export const DETECTION_INTERVAL_MS = 5 * 60_000;

export class DetectionService {
  readonly #deps: DetectionDeps;

  constructor(deps: DetectionDeps) {
    this.#deps = deps;
  }

  /**
   * Probes every integration once.
   *
   * One integration's failure must not stop the others, so each probe is
   * isolated and a thrown error becomes `unknown` rather than propagating.
   */
  async runOnce(now: number): Promise<void> {
    for (const module of this.#deps.registry.all()) {
      const detection = await this.#probe(module);

      await this.#deps.states.recordDetection({
        id: module.id,
        state: detection.state,
        version: detection.state === 'present' ? (detection.version ?? null) : null,
        evidence: detection.evidence,
        unknownReason: detection.state === 'unknown' ? detection.reason : null,
        degraded: detection.state === 'present' ? [...(detection.degraded ?? [])] : [],
        checkedAt: now,
      });
    }
  }

  async #probe(module: IntegrationModule): Promise<Detection> {
    try {
      return await module.detect({ probes: this.#deps.probes });
    } catch (error) {
      if (error instanceof ProbeDeniedError) {
        return { state: 'unknown', reason: 'rbac', evidence: error.message };
      }
      return {
        state: 'unknown',
        reason: 'error',
        evidence: error instanceof Error ? error.message : 'Detection failed',
      };
    }
  }

  async setOverride(id: string, override: IntegrationOverride): Promise<boolean> {
    if (!this.#deps.registry.byId(id)) return false;
    await this.#deps.states.setOverride(id, override);
    return true;
  }
}

/**
 * What the manifest should treat an integration as, once the user's override is
 * applied. Auto-detection is a default, never a cage.
 */
export function effectiveState(
  detected: 'present' | 'absent' | 'unknown',
  override: IntegrationOverride,
): 'present' | 'absent' | 'unknown' {
  if (override === 'force_on') return 'present';
  if (override === 'force_off') return 'absent';
  return detected;
}
