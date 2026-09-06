import { type DynamicModule, Module } from '@nestjs/common';
import type { AlertsService } from './alerts/service.js';
import type { AccountsService } from './auth/accounts.service.js';
import type { AgentsService } from './auth/agents.service.js';
import type { AuthService } from './auth/auth.service.js';
import type { BackupRunner } from './backup/runner.js';
import type { HostIngest } from './collect/host-ingest.js';
import type { LiveCache } from './collect/live-cache.js';
import type { Config } from './config.js';
import type { AgentTokensRepo } from './db/agent-tokens.repo.js';
import type { NodeSamplesRepo } from './db/node-samples.repo.js';
import type { NotificationsRepo } from './db/notifications.repo.js';
import type { HealthService } from './health.service.js';
import { AccountsController } from './http/accounts.controller.js';
import { AgentsController } from './http/agents.controller.js';
import { AlertsController } from './http/alerts.controller.js';
import { AuthController } from './http/auth.controller.js';
import { BackupsController } from './http/backups.controller.js';
import { CapabilitiesController } from './http/capabilities.controller.js';
import { HealthzController } from './http/healthz.controller.js';
import { IngestController } from './http/ingest.controller.js';
import { PasswordFreshGuard } from './http/password-fresh.guard.js';
import { QueryController } from './http/query.controller.js';
import { SessionGuard } from './http/session.guard.js';
import type { ServiceAccountVerifier } from './kube/sa-token.js';
import type { Dispatcher } from './notify/dispatcher.js';
import type { CapabilitiesService } from './plugins/capabilities.service.js';
import type { IngestPipeline } from './plugins/ingest.js';
import type { FacetQuery } from './query/facet-query.js';
import {
  ACCOUNTS_SERVICE,
  AGENT_TOKENS,
  AGENTS_SERVICE,
  ALERTS_SERVICE,
  AUTH_SERVICE,
  BACKUP_RUNNER,
  CAPABILITIES_SERVICE,
  CONFIG,
  DISPATCHER,
  HEALTH_SERVICE,
  HOST_INGEST,
  INGEST_PIPELINE,
  KUBE_NODE_NAMES,
  LIVE_CACHE,
  NODE_SAMPLES,
  NOTIFICATIONS_REPO,
  QUERY_SERVICE,
  SA_VERIFIER,
} from './tokens.js';

/**
 * Everything the HTTP layer needs, already constructed.
 *
 * The composition root builds these once in `main.ts` (or in a test) and hands
 * them over. Nest resolves nothing on its own, which is why the services in
 * this codebase are testable without a container.
 */
export interface AppDeps {
  config: Config;
  health: HealthService;
  auth: AuthService;
  accounts: AccountsService;
  capabilities: CapabilitiesService;
  query: FacetQuery;
  samples: NodeSamplesRepo;
  liveCache: LiveCache;
  pipeline: IngestPipeline;
  agentTokens: AgentTokensRepo;
  agents: AgentsService;
  /** Cluster node names, empty where kubitor has no Kubernetes access. */
  nodeNames: () => Promise<string[]>;
  hostIngest: HostIngest;
  /** Absent outside a cluster, where no projected token can be verified. */
  saVerifier: ServiceAccountVerifier | null;
  /** Absent unless a bucket is configured. */
  backup: BackupRunner | null;
  alerts: AlertsService;
  notifications: NotificationsRepo;
  dispatcher: Dispatcher;
}

@Module({})
export class AppModule {}

export function createAppModule(deps: AppDeps): DynamicModule {
  return {
    module: AppModule,
    controllers: [
      HealthzController,
      AuthController,
      AccountsController,
      AgentsController,
      BackupsController,
      AlertsController,
      CapabilitiesController,
      QueryController,
      IngestController,
    ],
    providers: [
      { provide: CONFIG, useValue: deps.config },
      { provide: HEALTH_SERVICE, useValue: deps.health },
      { provide: AUTH_SERVICE, useValue: deps.auth },
      { provide: ACCOUNTS_SERVICE, useValue: deps.accounts },
      { provide: CAPABILITIES_SERVICE, useValue: deps.capabilities },
      { provide: QUERY_SERVICE, useValue: deps.query },
      { provide: NODE_SAMPLES, useValue: deps.samples },
      { provide: LIVE_CACHE, useValue: deps.liveCache },
      { provide: INGEST_PIPELINE, useValue: deps.pipeline },
      { provide: AGENT_TOKENS, useValue: deps.agentTokens },
      { provide: AGENTS_SERVICE, useValue: deps.agents },
      { provide: KUBE_NODE_NAMES, useValue: deps.nodeNames },
      { provide: HOST_INGEST, useValue: deps.hostIngest },
      { provide: SA_VERIFIER, useValue: deps.saVerifier },
      { provide: BACKUP_RUNNER, useValue: deps.backup },
      { provide: ALERTS_SERVICE, useValue: deps.alerts },
      { provide: NOTIFICATIONS_REPO, useValue: deps.notifications },
      { provide: DISPATCHER, useValue: deps.dispatcher },
      SessionGuard,
      PasswordFreshGuard,
    ],
  };
}
