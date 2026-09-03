/**
 * Injection tokens.
 *
 * Every provider is registered by an explicit token and injected with
 * `@Inject(...)`. Nothing relies on `design:paramtypes`, so services stay plain
 * classes that construct fine outside the container — and the test toolchain
 * needs no decorator-metadata transform.
 */
export const CONFIG = Symbol('kubitor.config');
export const HEALTH_SERVICE = Symbol('kubitor.healthService');
export const AUTH_SERVICE = Symbol('kubitor.authService');
export const ACCOUNTS_SERVICE = Symbol('kubitor.accountsService');
export const CAPABILITIES_SERVICE = Symbol('kubitor.capabilitiesService');
export const QUERY_SERVICE = Symbol('kubitor.queryService');
export const NODE_SAMPLES = Symbol('kubitor.nodeSamples');
export const LIVE_CACHE = Symbol('kubitor.liveCache');
