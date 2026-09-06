/**
 * What an account may do.
 *
 * Three roles rather than a permission matrix, because a matrix is a feature
 * nobody has asked for and the wrong shape is harder to remove than to add.
 * The line that matters is between reading the cluster — which is what kubitor
 * is for — and reading or changing anything about the people and credentials
 * around it.
 */
export const ROLES = ['admin', 'operator', 'viewer'] as const;

export type Role = (typeof ROLES)[number];

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

/**
 * Everything a role is allowed to reach, by name.
 *
 * Named capabilities rather than route paths: a route can move, and the
 * question "who may mint an agent credential" should not have to be re-answered
 * when it does.
 */
export type Capability =
  /** Every screen about the cluster, and every export of one. */
  | 'cluster.read'
  /** Turning an integration on or off, and asking for a re-probe. */
  | 'integrations.write'
  /** The bucket, its keys, and running a backup by hand. */
  | 'backups.manage'
  /** Minting and revoking the credentials machines report with. */
  | 'agents.manage'
  /** Creating, resetting and deleting accounts, and setting roles. */
  | 'accounts.manage';

const GRANTS: Record<Role, readonly Capability[]> = {
  admin: [
    'cluster.read',
    'integrations.write',
    'backups.manage',
    'agents.manage',
    'accounts.manage',
  ],
  // Runs the cluster, and is trusted with what is installed on it. Not with the
  // credentials that would let them read the estate from outside it.
  operator: ['cluster.read', 'integrations.write'],
  // Can see what the cluster is doing and nothing about who watches it.
  viewer: ['cluster.read'],
};

export function can(role: string, capability: Capability): boolean {
  if (!isRole(role)) return false;
  return GRANTS[role].includes(capability);
}

/** Roles that hold a capability, for the checks that must not lock everybody out. */
export function rolesWith(capability: Capability): Role[] {
  return ROLES.filter((role) => can(role, capability));
}
