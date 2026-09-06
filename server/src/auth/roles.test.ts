import { describe, expect, it } from 'vitest';
import { type Capability, can, isRole, ROLES, rolesWith } from './roles.js';

const EVERY_CAPABILITY: Capability[] = [
  'cluster.read',
  'integrations.write',
  'backups.manage',
  'agents.manage',
  'accounts.manage',
];

describe('roles', () => {
  /** kubitor is for looking at a cluster; every role can do that. */
  it('lets every role read the cluster', () => {
    for (const role of ROLES) expect(can(role, 'cluster.read'), role).toBe(true);
  });

  it('gives admin everything', () => {
    for (const capability of EVERY_CAPABILITY)
      expect(can('admin', capability), capability).toBe(true);
  });

  /**
   * The line that matters: an operator runs the cluster and is trusted with
   * what is installed on it, not with the credentials that would let somebody
   * read the estate from outside it.
   */
  it('keeps credentials away from operator', () => {
    expect(can('operator', 'integrations.write')).toBe(true);
    expect(can('operator', 'agents.manage')).toBe(false);
    expect(can('operator', 'backups.manage')).toBe(false);
    expect(can('operator', 'accounts.manage')).toBe(false);
  });

  it('lets a viewer change nothing at all', () => {
    for (const capability of EVERY_CAPABILITY) {
      if (capability === 'cluster.read') continue;
      expect(can('viewer', capability), capability).toBe(false);
    }
  });

  /** An unknown role in the database is not a free pass. */
  it('refuses a role it does not know', () => {
    expect(can('superuser', 'cluster.read')).toBe(false);
    expect(isRole('superuser')).toBe(false);
  });

  it('names the roles holding a capability, for the last-admin check', () => {
    expect(rolesWith('accounts.manage')).toEqual(['admin']);
    expect(rolesWith('cluster.read')).toEqual(['admin', 'operator', 'viewer']);
  });
});
