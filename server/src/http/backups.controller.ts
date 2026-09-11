import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Inject,
  Optional,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { verifyPassword } from '../auth/password.js';
import type { BackupRunner } from '../backup/runner.js';
import { BACKUP_RUNNER } from '../tokens.js';
import { PasswordFreshGuard } from './password-fresh.guard.js';
import { type AuthenticatedRequest, requireCapability } from './request-context.js';
import { SessionGuard } from './session.guard.js';

const stepUp = z.object({ currentPassword: z.string().min(1).max(512) });

@Controller('api/backups')
@UseGuards(SessionGuard, PasswordFreshGuard)
export class BackupsController {
  readonly #runner: BackupRunner | null;

  constructor(@Optional() @Inject(BACKUP_RUNNER) runner: BackupRunner | null) {
    this.#runner = runner ?? null;
  }

  /**
   * What has been backed up, and whether backups are configured at all.
   *
   * Never the credentials. The endpoint and bucket are shown because an
   * operator has to be able to tell which bucket they are looking at; the keys
   * are not, because nothing on this screen needs them.
   */
  @Get()
  async list(@Req() request: AuthenticatedRequest): Promise<unknown> {
    requireCapability(request, 'backups.manage');
    if (!this.#runner) return { configured: false, backups: [] };
    return this.#runner.status();
  }

  @Post('run')
  @HttpCode(202)
  async run(@Req() request: AuthenticatedRequest, @Body() body: unknown): Promise<unknown> {
    const parsed = stepUp.safeParse(body);
    if (!parsed.success) throw new BadRequestException({ error: 'invalid_body' });

    const { account } = requireCapability(request, 'backups.manage');
    if (!(await verifyPassword(parsed.data.currentPassword, account.passwordHash))) {
      throw new ForbiddenException({ error: 'reauthentication_failed' });
    }

    if (!this.#runner?.configured) {
      throw new BadRequestException({ error: 'backup_not_configured' });
    }
    return this.#runner.runNow();
  }
}
