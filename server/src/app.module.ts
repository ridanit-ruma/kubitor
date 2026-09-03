import { type DynamicModule, Module } from '@nestjs/common';
import type { AccountsService } from './auth/accounts.service.js';
import type { AuthService } from './auth/auth.service.js';
import type { Config } from './config.js';
import type { HealthService } from './health.service.js';
import { AccountsController } from './http/accounts.controller.js';
import { AuthController } from './http/auth.controller.js';
import { CapabilitiesController } from './http/capabilities.controller.js';
import { HealthzController } from './http/healthz.controller.js';
import { PasswordFreshGuard } from './http/password-fresh.guard.js';
import { SessionGuard } from './http/session.guard.js';
import type { CapabilitiesService } from './plugins/capabilities.service.js';
import {
  ACCOUNTS_SERVICE,
  AUTH_SERVICE,
  CAPABILITIES_SERVICE,
  CONFIG,
  HEALTH_SERVICE,
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
}

@Module({})
export class AppModule {}

export function createAppModule(deps: AppDeps): DynamicModule {
  return {
    module: AppModule,
    controllers: [HealthzController, AuthController, AccountsController, CapabilitiesController],
    providers: [
      { provide: CONFIG, useValue: deps.config },
      { provide: HEALTH_SERVICE, useValue: deps.health },
      { provide: AUTH_SERVICE, useValue: deps.auth },
      { provide: ACCOUNTS_SERVICE, useValue: deps.accounts },
      { provide: CAPABILITIES_SERVICE, useValue: deps.capabilities },
      SessionGuard,
      PasswordFreshGuard,
    ],
  };
}
