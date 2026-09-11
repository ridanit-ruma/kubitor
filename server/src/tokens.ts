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
export const INGEST_PIPELINE = Symbol('kubitor.ingestPipeline');
export const AGENT_TOKENS = Symbol('kubitor.agentTokens');
export const AGENTS_SERVICE = Symbol('kubitor.agentsService');
/** Cluster node names, so an agent credential can be marked as also a node's. */
export const KUBE_NODE_NAMES = Symbol('kubitor.kubeNodeNames');
export const HOST_INGEST = Symbol('kubitor.hostIngest');
export const SA_VERIFIER = Symbol('kubitor.serviceAccountVerifier');
/** Absent unless a bucket is configured, which is what turns backups on. */
export const BACKUP_RUNNER = Symbol('kubitor.backupRunner');
export const ALERTS_SERVICE = Symbol('kubitor.alertsService');
export const NOTIFICATIONS_REPO = Symbol('kubitor.notificationsRepo');
export const DISPATCHER = Symbol('kubitor.dispatcher');
/** The settings the dashboard can edit, already loaded. */
export const SETTINGS_SERVICE = Symbol('kubitor.settingsService');
/** The audit trail, for the routes that have to leave a record. */
export const ACCOUNT_EVENTS = Symbol('kubitor.accountEvents');
