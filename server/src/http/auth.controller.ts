import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import type { AuthService } from '../auth/auth.service.js';
import { signSessionToken, verifySessionToken } from '../auth/tokens.js';
import type { Config } from '../config.js';
import { AUTH_SERVICE, CONFIG } from '../tokens.js';
import { clientIp } from './client-ip.js';
import { clearedSessionCookie, readSessionCookie, sessionCookie } from './cookies.js';
import { type AuthenticatedRequest, requireAuth } from './request-context.js';
import { SessionGuard } from './session.guard.js';

const loginBody = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(512),
});

const changePasswordBody = z.object({
  currentPassword: z.string().min(1).max(512),
  // Long enough to resist guessing, bounded so a huge input cannot be used to
  // make the server spend scrypt memory on it.
  newPassword: z.string().min(12).max(512),
});

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new BadRequestException({ error: 'invalid_body' });
  }
  return result.data;
}

@Controller('api/auth')
export class AuthController {
  readonly #auth: AuthService;
  readonly #config: Config;

  constructor(@Inject(AUTH_SERVICE) auth: AuthService, @Inject(CONFIG) config: Config) {
    this.#auth = auth;
    this.#config = config;
  }

  @Post('login')
  @HttpCode(200)
  async login(
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ): Promise<{ username: string; mustChangePassword: boolean }> {
    const { username, password } = parse(loginBody, body);
    const ip = clientIp(
      request.headers,
      this.#config.trustedProxyHeader,
      request.socket.remoteAddress,
    );

    const result = await this.#auth.login(username, password, ip, Date.now());

    if (!result.ok) {
      if (result.reason === 'locked') {
        response.setHeader('Retry-After', Math.ceil(result.retryAfterMs / 1000));
      }
      // One answer for every failure: a distinct message would say whether the
      // username exists.
      throw new UnauthorizedException({ error: 'invalid_credentials' });
    }

    const token = await signSessionToken(
      result.session.id,
      this.#config.sessionSecret,
      result.session.expiresAt,
    );

    response.setHeader(
      'Set-Cookie',
      sessionCookie(token, {
        secure: this.#config.cookieSecure,
        maxAgeMs: this.#config.sessionTtlMs,
      }),
    );

    // The body never carries the token — it lives in the HttpOnly cookie alone.
    return {
      username: result.account.username,
      mustChangePassword: result.account.mustChangePassword,
    };
  }

  @Post('logout')
  @HttpCode(204)
  async logout(
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    const token = readSessionCookie(request.headers.cookie);
    if (token) {
      const claims = await verifySessionToken(token, this.#config.sessionSecret);
      if (claims) await this.#auth.logout(claims.sid, Date.now());
    }

    response.setHeader('Set-Cookie', clearedSessionCookie(this.#config.cookieSecure));
  }

  @Get('me')
  @UseGuards(SessionGuard)
  me(@Req() request: AuthenticatedRequest): {
    username: string;
    mustChangePassword: boolean;
  } {
    const { account } = requireAuth(request);
    return { username: account.username, mustChangePassword: account.mustChangePassword };
  }

  /**
   * Deliberately guarded by SessionGuard only. PasswordFreshGuard would lock a
   * user out of the very endpoint that clears the flag.
   */
  @Post('change-password')
  @HttpCode(204)
  @UseGuards(SessionGuard)
  async changePassword(@Req() request: AuthenticatedRequest, @Body() body: unknown): Promise<void> {
    const { currentPassword, newPassword } = parse(changePasswordBody, body);
    const { account, session } = requireAuth(request);

    const changed = await this.#auth.changePassword(
      account.id,
      currentPassword,
      newPassword,
      session.id,
      Date.now(),
    );

    if (!changed) throw new UnauthorizedException({ error: 'invalid_credentials' });
  }
}
