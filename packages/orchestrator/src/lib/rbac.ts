import { AbilityBuilder, createMongoAbility, MongoAbility } from '@casl/ability';
import type { PlatformConfig } from '@/types';

/** Resolve a platform userId to a config username */
export function resolveUser(
  userId: string,
  platform: string,
  config: PlatformConfig,
): string | undefined {
  for (const [username, userConfig] of Object.entries(config.rbac.users)) {
    if (userConfig.identities[platform] === userId) {
      return username;
    }
  }
  return undefined;
}

/** Get all roles for a resolved username */
function getUserRoles(username: string, config: PlatformConfig): string[] {
  const userConfig = config.rbac.users[username];
  return userConfig?.roles ?? [];
}

/** Get all permissions from a set of role names */
function getPermissions(roles: string[], config: PlatformConfig): string[] {
  const permissions: string[] = [];
  for (const roleName of roles) {
    const role = config.rbac.roles[roleName];
    if (role) {
      permissions.push(...role.permissions);
    }
  }
  return permissions;
}

/** Build a CASL ability from user identity.
 * Permissions in the format "category:subject" become CASL rules:
 *   "agent:main" => can('access', 'agent:main')
 *   "agent:*"    => can('manage', 'all')  for agent access, we also add specific entries
 * The ability can be checked via: ability.can('access', 'agent:<id>')
 */
export function buildAbility(
  userId: string,
  platform: string,
  config: PlatformConfig,
): MongoAbility {
  const { can, build } = new AbilityBuilder(createMongoAbility);

  const username = resolveUser(userId, platform, config);
  if (!username) {
    return build();
  }

  const roles = getUserRoles(username, config);
  const permissions = getPermissions(roles, config);

  for (const perm of permissions) {
    const [category, subject] = perm.split(':');
    if (subject === '*') {
      // Wildcard: use 'manage' + 'all' which CASL treats as a universal grant
      can('manage', 'all');
    } else {
      can('access', `${category}:${subject}`);
    }
  }

  return build();
}

/** Check if a user (by platform identity) can access a specific agent */
export function checkAccess(
  userId: string,
  platform: string,
  agentId: string,
  config: PlatformConfig,
): boolean {
  const username = resolveUser(userId, platform, config);
  if (!username) return false;

  const roles = getUserRoles(username, config);
  const permissions = getPermissions(roles, config);

  for (const perm of permissions) {
    if (perm === `agent:${agentId}` || perm === 'agent:*') {
      return true;
    }
  }

  return false;
}

/** Check if a set of roles grants access to a specific tool */
export function checkToolAccess(
  roles: string[],
  toolName: string,
  config: PlatformConfig,
): boolean {
  const permissions = getPermissions(roles, config);

  for (const perm of permissions) {
    if (perm === `tool:${toolName}` || perm === 'tool:*') {
      return true;
    }
  }

  return false;
}
