import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
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
import type { AccountSummary, AccountsError, AccountsService } from '../auth/accounts.service.js';
import { ACCOUNTS_SERVICE } from '../tokens.js';
import { PasswordFreshGuard } from './password-fresh.guard.js';
import { type AuthenticatedRequest, requireAuth } from './request-context.js';
import { SessionGuard } from './session.guard.js';

const stepUp = z.object({ currentPassword: z.string().min(1).max(512) });

const createBody = stepUp.extend({
  username: z
    .string()
    .min(1)
    .max(64)
    // Usernames appear in the audit log and in URLs; keep them boring.
    .regex(/^[a-z0-9][a-z0-9._-]*$/, 'must be lowercase letters, digits, dot, dash or underscore'),
});

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) throw new BadRequestException({ error: 'invalid_body' });
  return result.data;
}

function raise(error: AccountsError): never {
  switch (error) {
    case 'reauthentication_failed':
      throw new ForbiddenException({ error });
    case 'username_taken':
      throw new ConflictException({ error });
    case 'not_found':
      throw new NotFoundException({ error });
    default:
      throw new ForbiddenException({ error });
  }
}

@Controller('api/accounts')
@UseGuards(SessionGuard, PasswordFreshGuard)
export class AccountsController {
  readonly #accounts: AccountsService;

  constructor(@Inject(ACCOUNTS_SERVICE) accounts: AccountsService) {
    this.#accounts = accounts;
  }

  @Get()
  async list(): Promise<{ accounts: AccountSummary[] }> {
    return { accounts: await this.#accounts.list() };
  }

  @Post()
  @HttpCode(201)
  async create(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<{ account: AccountSummary; password: string }> {
    const { username, currentPassword } = parse(createBody, body);
    const { account } = requireAuth(request);

    const result = await this.#accounts.create(account, currentPassword, username, Date.now());
    if (!result.ok) raise(result.error);

    return result.value;
  }

  @Post(':id/reset-password')
  @HttpCode(200)
  async resetPassword(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<{ password: string }> {
    const { currentPassword } = parse(stepUp, body);
    const { account } = requireAuth(request);

    const result = await this.#accounts.resetPassword(account, currentPassword, id, Date.now());
    if (!result.ok) raise(result.error);

    return result.value;
  }

  /**
   * A POST rather than a DELETE because it carries a step-up body, and bodies
   * on DELETE are poorly supported by proxies and clients alike.
   */
  @Post(':id/delete')
  @HttpCode(204)
  async remove(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<void> {
    const { currentPassword } = parse(stepUp, body);
    const { account } = requireAuth(request);

    const result = await this.#accounts.delete(account, currentPassword, id, Date.now());
    if (!result.ok) raise(result.error);
  }
}
