import type { MessageType } from "./catalog.js";
import type { Role } from "./types.js";

const ALL_ROLES: readonly Role[] = Object.freeze(["host", "participant"]);

/** Types restricted to specific roles; every other type is allowed for all roles. */
export const ROLE_POLICY: Readonly<Partial<Record<MessageType, readonly Role[]>>> = Object.freeze({
  "media.screen.started": Object.freeze(["host"] as Role[]),
  "media.screen.stopped": Object.freeze(["host"] as Role[]),
});

export function allowedRoles(type: MessageType): readonly Role[] {
  return ROLE_POLICY[type] ?? ALL_ROLES;
}

export function isRoleAllowed(type: MessageType, role: Role): boolean {
  return allowedRoles(type).includes(role);
}
