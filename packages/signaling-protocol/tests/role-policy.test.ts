import assert from "node:assert/strict";
import test from "node:test";
import { MESSAGE_TYPES, ROLE_POLICY, allowedRoles, isRoleAllowed, type MessageType, type Role } from "../src/index.js";

const HOST_ONLY: readonly MessageType[] = [
  "media.screen.started",
  "media.screen.stopped",
  "meeting.end" as MessageType,
];

test("the role policy table is frozen and only restricts host-only types", () => {
  assert.ok(Object.isFrozen(ROLE_POLICY));
  assert.deepEqual(Object.keys(ROLE_POLICY).sort(), [...HOST_ONLY].sort());
  for (const type of HOST_ONLY) {
    if (type in ROLE_POLICY) assert.ok(Object.isFrozen(ROLE_POLICY[type]));
  }
});

test("host-only types allow host and refuse participant", () => {
  for (const type of HOST_ONLY) {
    assert.deepEqual([...allowedRoles(type)], ["host"]);
    assert.equal(isRoleAllowed(type, "host"), true);
    assert.equal(isRoleAllowed(type, "participant"), false);
  }
});

test("every other catalog type allows both roles", () => {
  for (const type of MESSAGE_TYPES) {
    if (HOST_ONLY.includes(type)) continue;
    assert.equal(isRoleAllowed(type, "host"), true, type);
    assert.equal(isRoleAllowed(type, "participant"), true, type);
  }
});

test("an unknown role is never allowed", () => {
  for (const type of MESSAGE_TYPES) {
    assert.equal(isRoleAllowed(type, "observer" as Role), false, type);
  }
});
