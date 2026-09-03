/**
 * Lockout is keyed on the caller's address, never on the username.
 *
 * Counting failures per username hands anyone a denial-of-service primitive:
 * fail ten times against a known account and its owner is locked out. Keying on
 * the address costs an attacker their own access instead.
 */
export const LOCKOUT = {
  windowMs: 15 * 60_000,
  threshold: 10,
  cooldownMs: 15 * 60_000,
} as const;

/**
 * Every failed login takes the same time regardless of why it failed, so the
 * response cannot be used to learn whether a username exists.
 */
export const FAILED_LOGIN_DELAY_MS = 500;

export interface LoginDecision {
  allowed: boolean;
  retryAfterMs?: number;
}

export function decideLogin(recentFailures: number): LoginDecision {
  if (recentFailures < LOCKOUT.threshold) return { allowed: true };
  return { allowed: false, retryAfterMs: LOCKOUT.cooldownMs };
}

/** Start of the window `recentFailures` should be counted over. */
export function lockoutWindowStart(now: number): number {
  return now - LOCKOUT.windowMs;
}
