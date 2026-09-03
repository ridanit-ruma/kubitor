import { Controller, Get, Inject } from '@nestjs/common';
import type { HealthService } from '../health.service.js';
import { HEALTH_SERVICE } from '../tokens.js';

@Controller('api')
export class HealthzController {
  readonly #health: HealthService;

  constructor(@Inject(HEALTH_SERVICE) health: HealthService) {
    this.#health = health;
  }

  /** Liveness: cheap, touches nothing. */
  @Get('healthz')
  healthz(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /** Readiness: the process is only useful once its database answers. */
  @Get('readyz')
  async readyz(): Promise<{ status: 'ok' | 'degraded'; database: boolean }> {
    const database = await this.#health.databaseReachable();
    return { status: database ? 'ok' : 'degraded', database };
  }
}
