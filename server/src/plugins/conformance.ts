import { describe, expect, it } from 'vitest';
import { TABLES } from '../db/tables.js';
import { type FakeClusterState, fakeProbes } from '../test/fake-probes.js';
import type { IntegrationModule } from './contract.js';
import { facetDescriptor } from './facets.js';
import { IntegrationRegistry } from './registry.js';

export interface ConformanceFixtures {
  /** A cluster where this integration is installed. */
  present: FakeClusterState;
  /** A cluster where it is not. */
  absent: FakeClusterState;
  /** Probe names to deny, to prove the module reports `unknown`. */
  deniedProbes: readonly string[];
}

/**
 * The suite every integration must pass.
 *
 * Integrations are the part of this codebase that grows without bound, so the
 * contract is enforced by a shared test rather than by review attention.
 */
export function describeIntegrationContract(
  module: IntegrationModule,
  fixtures: ConformanceFixtures,
): void {
  describe(`${module.id} contract`, () => {
    it('is accepted by the registry', () => {
      expect(() => new IntegrationRegistry([module])).not.toThrow();
    });

    it('declares at least one facet', () => {
      expect(module.facets.length).toBeGreaterThan(0);
    });

    it('declares the permissions its probes need', () => {
      // A module that reads nothing needs nothing; anything else must say so,
      // or the shipped ClusterRole will be short and detection will report
      // `unknown` in production for no visible reason.
      if (module.facets.length > 0 && module.scope === 'cluster') {
        expect(module.requiredRbac.length).toBeGreaterThan(0);
      }
    });

    it('reports present with evidence on a cluster that has it', async () => {
      const detection = await module.detect({ probes: fakeProbes(fixtures.present) });

      expect(detection.state).toBe('present');
      expect(detection.evidence.length).toBeGreaterThan(0);
    });

    it('reports absent with evidence on a cluster that does not', async () => {
      const detection = await module.detect({ probes: fakeProbes(fixtures.absent) });

      expect(detection.state).toBe('absent');
      expect(detection.evidence.length).toBeGreaterThan(0);
    });

    /**
     * A denied probe must surface as `unknown`. Reporting `absent` would tell
     * an operator they do not run something they do run.
     */
    it('lets a denied probe escape as ProbeDeniedError rather than reporting absent', async () => {
      if (fixtures.deniedProbes.length === 0) return;

      const probes = fakeProbes({ ...fixtures.present, denied: fixtures.deniedProbes });

      await expect(module.detect({ probes })).rejects.toThrow(/Not permitted/);
    });

    it('emits only facets it declared', async () => {
      const declared = new Set<string>(module.facets);

      for (const collector of module.collectors()) {
        if (collector.kind === 'push') {
          expect(declared.has(collector.facet), collector.facet).toBe(true);
          continue;
        }
        if (collector.kind !== 'poll') continue;

        const emissions = await collector.run({
          probes: fakeProbes(fixtures.present),
          now: () => Date.now(),
        });

        for (const emission of emissions) {
          expect(declared.has(emission.facet), emission.facet).toBe(true);
        }
      }
    });

    it('emits rows its facets can actually store', async () => {
      for (const collector of module.collectors()) {
        if (collector.kind !== 'poll') continue;

        const emissions = await collector.run({
          probes: fakeProbes(fixtures.present),
          now: () => Date.now(),
        });

        for (const emission of emissions) {
          const descriptor = facetDescriptor(emission.facet);
          expect(descriptor, `${emission.facet} has no storage descriptor`).toBeDefined();

          for (const row of emission.rows) {
            const parsed = descriptor?.schema.safeParse(row);
            expect(parsed?.success, `${emission.facet}: ${JSON.stringify(row)}`).toBe(true);
          }
        }
      }
    });

    it('registers every extra table with a retention policy', () => {
      for (const table of module.tables ?? []) {
        const spec = TABLES.find((entry) => entry.name === table);
        expect(spec, `${table} is not in TABLES`).toBeDefined();
        if (spec?.kind === 'event') {
          expect(spec.retentionMs, `${table} has no retention`).toBeGreaterThan(0);
        }
      }
    });

    it('gives every collector a unique id', () => {
      const ids = module.collectors().map((collector) => collector.id);
      expect(new Set(ids).size).toBe(ids.length);
    });
  });
}
