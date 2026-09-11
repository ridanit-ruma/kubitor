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
import type { SettingsService } from '../settings/service.js';
import { BACKUP_RUNNER, SETTINGS_SERVICE } from '../tokens.js';
import { PasswordFreshGuard } from './password-fresh.guard.js';
import { type AuthenticatedRequest, requireCapability } from './request-context.js';
import { SessionGuard } from './session.guard.js';

const stepUp = z.object({ currentPassword: z.string().min(1).max(512) });

@Controller('api/backups')
@UseGuards(SessionGuard, PasswordFreshGuard)
export class BackupsController {
  readonly #runner: BackupRunner | null;
  readonly #settings: SettingsService | null;

  constructor(
    @Optional() @Inject(BACKUP_RUNNER) runner: BackupRunner | null,
    @Optional() @Inject(SETTINGS_SERVICE) settings: SettingsService | null,
  ) {
    this.#runner = runner ?? null;
    this.#settings = settings ?? null;
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

    const status = await this.#runner.status();
    if (!status.configured) return status;

    // Whether the bucket's own credentials are inside the file being uploaded
    // to it. It belongs on this response rather than the runner's, because it
    // is a fact about how the destination is stored, not about the destination.
    return { ...status, secretsInTheClear: this.#settings?.backupSecretInTheClear ?? false };
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
