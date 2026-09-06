import {
  BadRequestException,
  Body,
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
import type { AgentSummary, AgentsError, AgentsService } from '../auth/agents.service.js';
import { AGENTS_SERVICE, KUBE_NODE_NAMES } from '../tokens.js';
import { PasswordFreshGuard } from './password-fresh.guard.js';
import { type AuthenticatedRequest, requireCapability } from './request-context.js';
import { SessionGuard } from './session.guard.js';

const stepUp = z.object({ currentPassword: z.string().min(1).max(512) });
const issueBody = stepUp.extend({ name: z.string().min(1).max(253) });

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) throw new BadRequestException({ error: 'invalid_body' });
  return result.data;
}

function raise(error: AgentsError): never {
  if (error === 'not_found') throw new NotFoundException({ error });
  if (error === 'invalid_name') throw new BadRequestException({ error });
  throw new ForbiddenException({ error });
}

/**
 * Credentials for agents that cannot present a projected service-account token.
 *
 * In-cluster agents authenticate with a token the API server signed, which
 * names the node it was issued on and never has to be distributed. A machine
 * outside the cluster has no such token, and until this existed there was no
 * way to give it one.
 */
@Controller('api/agents')
@UseGuards(SessionGuard, PasswordFreshGuard)
export class AgentsController {
  readonly #agents: AgentsService;
  readonly #nodeNames: () => Promise<string[]>;

  constructor(
    @Inject(AGENTS_SERVICE) agents: AgentsService,
    @Inject(KUBE_NODE_NAMES) nodeNames: () => Promise<string[]>,
  ) {
    this.#agents = agents;
    this.#nodeNames = nodeNames;
  }

  @Get()
  async list(@Req() request: AuthenticatedRequest): Promise<{ agents: AgentSummary[] }> {
    requireCapability(request, 'agents.manage');
    return { agents: await this.#agents.list(await this.#nodeNames()) };
  }

  @Post()
  @HttpCode(201)
  async issue(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<{ name: string; token: string }> {
    const { name, currentPassword } = parse(issueBody, body);
    const { account } = requireCapability(request, 'agents.manage');

    const result = await this.#agents.issue(account, currentPassword, name, Date.now());
    if (!result.ok) raise(result.error);

    return result.value;
  }

  // A POST rather than a DELETE, because revoking carries a body: the actor
  // re-authenticates, and `accounts` already revokes this way.
  @Post(':name/revoke')
  @HttpCode(204)
  async revoke(
    @Req() request: AuthenticatedRequest,
    @Param('name') name: string,
    @Body() body: unknown,
  ): Promise<void> {
    const { currentPassword } = parse(stepUp, body);
    const { account } = requireCapability(request, 'agents.manage');

    const result = await this.#agents.revoke(account, currentPassword, name);
    if (!result.ok) raise(result.error);
  }
}
