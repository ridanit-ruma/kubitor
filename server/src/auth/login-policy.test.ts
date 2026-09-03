import { describe, expect, it } from 'vitest';
import { decideLogin, LOCKOUT, lockoutWindowStart } from './login-policy.js';

describe('decideLogin', () => {
  it('allows while failures stay under the threshold', () => {
    expect(decideLogin(0).allowed).toBe(true);
    expect(decideLogin(LOCKOUT.threshold - 1).allowed).toBe(true);
  });

  it('locks at the threshold and reports how long to wait', () => {
    const decision = decideLogin(LOCKOUT.threshold);

    expect(decision.allowed).toBe(false);
    expect(decision.retryAfterMs).toBe(LOCKOUT.cooldownMs);
  });

  it('stays locked beyond the threshold', () => {
    expect(decideLogin(LOCKOUT.threshold + 50).allowed).toBe(false);
  });
});

describe('lockoutWindowStart', () => {
  it('looks back exactly one window', () => {
    expect(lockoutWindowStart(1_000_000)).toBe(1_000_000 - LOCKOUT.windowMs);
  });
});
