import { FACET_IDS, type FacetId } from '@kubitor/shared';
import type { IntegrationModule } from './contract.js';

const ID_PATTERN = /^[a-z][a-z0-9-]*$/;

/**
 * The set of integrations this build ships.
 *
 * Validation happens at construction so a malformed module fails at startup
 * with a clear message rather than misbehaving in production.
 */
export class IntegrationRegistry {
  readonly #byId: Map<string, IntegrationModule>;

  constructor(modules: readonly IntegrationModule[]) {
    this.#byId = new Map();

    for (const module of modules) {
      if (!ID_PATTERN.test(module.id)) {
        throw new Error(`Integration id "${module.id}" must be lowercase kebab-case`);
      }
      if (this.#byId.has(module.id)) {
        throw new Error(`Duplicate integration id "${module.id}"`);
      }
      for (const facet of module.facets) {
        if (!(FACET_IDS as readonly string[]).includes(facet)) {
          throw new Error(`Integration "${module.id}" declares unknown facet "${facet}"`);
        }
      }
      for (const table of module.tables ?? []) {
        if (!table.startsWith(`x_${module.id.replaceAll('-', '_')}_`)) {
          throw new Error(
            `Integration "${module.id}" table "${table}" must be prefixed x_${module.id.replaceAll('-', '_')}_`,
          );
        }
      }

      this.#byId.set(module.id, module);
    }
  }

  all(): readonly IntegrationModule[] {
    return [...this.#byId.values()];
  }

  byId(id: string): IntegrationModule | undefined {
    return this.#byId.get(id);
  }

  /** Integrations that could feed a facet, regardless of whether they are present. */
  sourcesOf(facet: FacetId): readonly string[] {
    return this.all()
      .filter((module) => module.facets.includes(facet))
      .map((module) => module.id);
  }
}
