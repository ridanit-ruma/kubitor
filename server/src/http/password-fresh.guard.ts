import { type CanActivate, type ExecutionContext, ForbiddenException } from '@nestjs/common';
import type { AuthenticatedRequest } from './request-context.js';

/**
 * Refuses everything until a first-login password change has happened.
 *
 * Enforced on the server, not merely in the UI: a client that skips the change
 * screen must still get nowhere with the default password.
 */
export class PasswordFreshGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();

    if (request.kubitor?.account.mustChangePassword) {
      throw new ForbiddenException({ error: 'password_change_required' });
    }

    return true;
  }
}
