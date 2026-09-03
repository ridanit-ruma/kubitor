import { type DynamicModule, Module } from '@nestjs/common';
import type { Config } from './config.js';
import type { HealthService } from './health.service.js';
import { HealthzController } from './http/healthz.controller.js';
import { CONFIG, HEALTH_SERVICE } from './tokens.js';

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
}

@Module({})
export class AppModule {}

export function createAppModule(deps: AppDeps): DynamicModule {
  return {
    module: AppModule,
    controllers: [HealthzController],
    providers: [
      { provide: CONFIG, useValue: deps.config },
      { provide: HEALTH_SERVICE, useValue: deps.health },
    ],
  };
}
