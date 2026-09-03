import type { IntegrationModule } from './contract.js';

/**
 * Integrations this build ships.
 *
 * Adding one is a pull request against this list plus a module directory — that
 * is the whole extension mechanism, and it is why there is no plugin runtime to
 * sandbox or version.
 */
export const INTEGRATIONS: readonly IntegrationModule[] = [];
