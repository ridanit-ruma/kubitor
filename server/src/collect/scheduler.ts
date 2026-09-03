import type { ClusterProbes, Collector, IntegrationModule } from '../plugins/contract.js';
import type { IngestPipeline } from '../plugins/ingest.js';

export interface SchedulerDeps {
  pipeline: IngestPipeline;
  probes: ClusterProbes;
  now(): number;
  onError(collectorId: string, error: unknown): void;
}

interface Running {
  timer: NodeJS.Timeout;
}

/**
 * Drives poll collectors and funnels their output into the pipeline.
 *
 * One collector failing must never stop another: a cluster where the kubelet is
 * unreachable should still show workloads, and a broken integration should cost
 * only its own screens.
 */
export class CollectorScheduler {
  readonly #deps: SchedulerDeps;
  readonly #running: Running[] = [];
  #stopped = false;

  constructor(deps: SchedulerDeps) {
    this.#deps = deps;
  }

  start(modules: readonly IntegrationModule[]): void {
    for (const module of modules) {
      for (const collector of module.collectors()) {
        if (collector.kind !== 'poll') continue;
        this.#schedule(module.id, collector);
      }
    }
  }

  #schedule(integration: string, collector: Extract<Collector, { kind: 'poll' }>): void {
    const tick = (): void => {
      void this.runOnce(integration, collector);
    };

    // Run immediately so a fresh pod has data before the first interval passes.
    tick();

    const timer = setInterval(tick, collector.intervalMs);
    timer.unref();
    this.#running.push({ timer });
  }

  /** Exposed for tests and for an on-demand refresh. */
  async runOnce(
    integration: string,
    collector: Extract<Collector, { kind: 'poll' }>,
  ): Promise<void> {
    if (this.#stopped) return;

    try {
      const emissions = await collector.run({
        probes: this.#deps.probes,
        now: this.#deps.now,
      });

      for (const emission of emissions) {
        await this.#deps.pipeline.ingest(
          integration,
          emission.facet,
          emission.rows,
          this.#deps.now(),
        );
      }
    } catch (error) {
      this.#deps.onError(collector.id, error);
    }
  }

  stop(): void {
    this.#stopped = true;
    for (const running of this.#running) clearInterval(running.timer);
    this.#running.length = 0;
  }
}
