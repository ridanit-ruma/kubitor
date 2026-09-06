import type { CapabilityManifest } from '@kubitor/shared';
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import type { CapabilitiesService } from '../plugins/capabilities.service.js';
import { CAPABILITIES_SERVICE } from '../tokens.js';
import { PasswordFreshGuard } from './password-fresh.guard.js';
import { type AuthenticatedRequest, requireAuth, requireCapability } from './request-context.js';
import { SessionGuard } from './session.guard.js';

const overrideBody = z.object({
  override: z.enum(['auto', 'force_on', 'force_off']),
});

@Controller('api')
@UseGuards(SessionGuard, PasswordFreshGuard)
export class CapabilitiesController {
  readonly #capabilities: CapabilitiesService;

  constructor(@Inject(CAPABILITIES_SERVICE) capabilities: CapabilitiesService) {
    this.#capabilities = capabilities;
  }

  /** What this cluster can show. The client builds its navigation from this. */
  @Get('capabilities')
  async manifest(@Req() request: AuthenticatedRequest): Promise<CapabilityManifest> {
    const { account } = requireAuth(request);
    return this.#capabilities.manifest(Date.now(), account.role);
  }

  @Post('capabilities/rescan')
  @HttpCode(200)
  async rescan(@Req() request: AuthenticatedRequest): Promise<CapabilityManifest> {
    const { account } = requireCapability(request, 'integrations.write');

    const now = Date.now();
    await this.#capabilities.rescan(now);
    return this.#capabilities.manifest(now, account.role);
  }

  @Post('integrations/:id/override')
  @HttpCode(204)
  async setOverride(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<void> {
    requireCapability(request, 'integrations.write');

    const parsed = overrideBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException({ error: 'invalid_body' });

    const applied = await this.#capabilities.setOverride(id, parsed.data.override);
    if (!applied) throw new NotFoundException({ error: 'not_found' });
  }
}
