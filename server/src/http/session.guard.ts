import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { AuthService } from '../auth/auth.service.js';
import { verifySessionToken } from '../auth/tokens.js';
import type { Config } from '../config.js';
import { AUTH_SERVICE, CONFIG } from '../tokens.js';
import { readSessionCookie } from './cookies.js';
import type { AuthenticatedRequest } from './request-context.js';

@Injectable()
export class SessionGuard implements CanActivate {
  readonly #auth: AuthService;
  readonly #config: Config;

  constructor(@Inject(AUTH_SERVICE) auth: AuthService, @Inject(CONFIG) config: Config) {
    this.#auth = auth;
    this.#config = config;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();

    const token = readSessionCookie(request.headers.cookie);
    if (!token) throw new UnauthorizedException();

    const claims = await verifySessionToken(token, this.#config.sessionSecret);
    if (!claims) throw new UnauthorizedException();

    // The signature only proves the token is ours. Whether the session is still
    // alive is state, and it is checked on every request so a logout or a
    // password reset takes effect immediately.
    const validated = await this.#auth.validate(claims.sid, Date.now());
    if (!validated) throw new UnauthorizedException();

    request.kubitor = validated;
    return true;
  }
}
