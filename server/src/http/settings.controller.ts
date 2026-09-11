import type { BackupView, NotifyView } from '@kubitor/shared';
import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Inject,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { verifyPassword } from '../auth/password.js';
import type { AccountEventsRepo } from '../db/account-events.repo.js';
import type { Dispatcher } from '../notify/dispatcher.js';
import { SettingsKeyMissing } from '../settings/secrets.js';
import type { SettingsService } from '../settings/service.js';
import { BACKUP_INPUT, NOTIFY_INPUT, SettingsInvalid } from '../settings/view.js';
import { ACCOUNT_EVENTS, DISPATCHER, SETTINGS_SERVICE } from '../tokens.js';
import { PasswordFreshGuard } from './password-fresh.guard.js';
import { type AuthenticatedRequest, requireCapability } from './request-context.js';
import { SessionGuard } from './session.guard.js';

const testBody = z.object({ channel: z.string().min(1).max(32) });
const backupBody = BACKUP_INPUT.extend({ currentPassword: z.string().min(1).max(512) });

/**
 * The settings a running server can be told to change its mind about.
 *
 * Everything here is an operational choice — where alerts go, where the
 * database is copied to — rather than a fact about where the server sits. The
 * values that would lock somebody out of the thing they are editing stay in the
 * environment, and are not reachable from this controller at all.
 */
@Controller('api/settings')
@UseGuards(SessionGuard, PasswordFreshGuard)
export class SettingsController {
  readonly #settings: SettingsService;
  readonly #events: AccountEventsRepo;
  readonly #dispatcher: Dispatcher;

  constructor(
    @Inject(SETTINGS_SERVICE) settings: SettingsService,
    @Inject(ACCOUNT_EVENTS) events: AccountEventsRepo,
    @Inject(DISPATCHER) dispatcher: Dispatcher,
  ) {
    this.#settings = settings;
    this.#events = events;
    this.#dispatcher = dispatcher;
  }

  /** Never a secret. Only whether there is one, so a form can say "configured". */
  @Get('notify')
  notify(@Req() request: AuthenticatedRequest): NotifyView {
    requireCapability(request, 'notify.manage');
    return this.#settings.notifyView();
  }

  @Put('notify')
  @HttpCode(200)
  async saveNotify(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<{ changed: string[] }> {
    const { account } = requireCapability(request, 'notify.manage');

    const parsed = NOTIFY_INPUT.safeParse(body);
    if (!parsed.success) throw new BadRequestException({ error: 'invalid_body' });

    const changed = await guard(() => this.#settings.putNotify(parsed.data));
    await this.#record(account.id, 'notify', changed);

    return { changed };
  }

  /**
   * One message, to one channel, now.
   *
   * Not a nicety: a webhook URL that is wrong fails silently at 3am, and a form
   * with no way to prove it works is a form nobody trusts.
   */
  @Post('notify/test')
  @HttpCode(200)
  async testNotify(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<{ ok: boolean; error?: string }> {
    const { account } = requireCapability(request, 'notify.manage');

    const parsed = testBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException({ error: 'invalid_body' });

    return this.#dispatcher.test(parsed.data.channel, account.username);
  }

  @Get('backup')
  backup(@Req() request: AuthenticatedRequest): BackupView {
    requireCapability(request, 'backups.manage');
    return this.#settings.backupView();
  }

  /**
   * Asks for the caller's password, as running a backup by hand already does.
   *
   * The bucket's keys are the same credentials in both cases, and moving where
   * the database is copied to is not the smaller of the two actions.
   */
  @Put('backup')
  @HttpCode(200)
  async saveBackup(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<{ changed: string[] }> {
    const { account } = requireCapability(request, 'backups.manage');

    const parsed = backupBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException({ error: 'invalid_body' });

    if (!(await verifyPassword(parsed.data.currentPassword, account.passwordHash))) {
      throw new ForbiddenException({ error: 'reauthentication_failed' });
    }

    const { currentPassword: _ignored, ...input } = parsed.data;
    const changed = await guard(() => this.#settings.putBackup(input));
    await this.#record(account.id, 'backup', changed);

    return { changed };
  }

  /** Who, when, which document, and which fields. Never the values. */
  async #record(actorId: string, document: string, changed: string[]): Promise<void> {
    if (changed.length === 0) return;

    await this.#events.record({
      at: Date.now(),
      actorId,
      action: 'settings_change',
      subject: document,
      detail: { fields: changed },
    });
  }
}

/**
 * Turns the two ways a write can be refused into the answers a form can act on.
 *
 * `SettingsInvalid` carries the field so the screen can mark it;
 * `SettingsKeyMissing` is not the operator's mistake and gets a code of its own,
 * because the fix is in the Deployment rather than in the form.
 */
async function guard(write: () => Promise<string[]>): Promise<string[]> {
  try {
    return await write();
  } catch (error) {
    if (error instanceof SettingsInvalid) {
      throw new BadRequestException({ error: 'invalid_settings', field: error.field });
    }
    if (error instanceof SettingsKeyMissing) {
      throw new BadRequestException({ error: 'settings_key_missing' });
    }
    throw error;
  }
}
