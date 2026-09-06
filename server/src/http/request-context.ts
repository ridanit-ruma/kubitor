import { ForbiddenException } from '@nestjs/common';
import type { Request } from 'express';
import { type Capability, can } from '../auth/roles.js';
import type { Account } from '../db/accounts.repo.js';
import type { Session } from '../db/sessions.repo.js';

/** What SessionGuard attaches once it has authenticated a request. */
export interface AuthenticatedRequest extends Request {
  kubitor?: {
    account: Account;
    session: Session;
  };
}

export function requireAuth(request: AuthenticatedRequest): {
  account: Account;
  session: Session;
} {
  if (!request.kubitor) {
    // Reaching here means a route was exposed without SessionGuard.
    throw new Error('Route is missing SessionGuard');
  }
  return request.kubitor;
}

/**
 * The account behind this request, if it may do the thing being asked.
 *
 * Checked here rather than by a guard reading decorator metadata, because
 * nothing in this codebase relies on that metadata and one explicit call at the
 * top of a handler is easier to audit than an annotation that can be forgotten
 * without anything failing.
 *
 * The client hides what a role cannot reach, and that is a courtesy. This is
 * the control.
 */
export function requireCapability(
  request: AuthenticatedRequest,
  capability: Capability,
): { account: Account; session: Session } {
  const context = requireAuth(request);
  if (!can(context.account.role, capability)) {
    throw new ForbiddenException({ error: 'forbidden', capability });
  }
  return context;
}
