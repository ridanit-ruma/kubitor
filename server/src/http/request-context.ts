import type { Request } from 'express';
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
