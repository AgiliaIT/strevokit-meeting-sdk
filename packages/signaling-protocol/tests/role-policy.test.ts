import assert from "node:assert/strict";
import test from "node:test";
import { MESSAGE_TYPES, ROLE_POLICY, allowedRoles, isRoleAllowed, type MessageType, type Role } from "../src/index.js";

const SCREEN: readonly MessageType[] = ["media.screen.started", "media.screen.stopped"];

test("the role policy table is frozen and only restricts screen announcements", () => {
  assert.ok(Object.isFrozen(ROLE_POLICY));
  assert.deepEqual(Object.keys(ROLE_POLICY).sort(), [...SCREEN].sort());
  for (const type of SCREEN) assert.ok(Object.isFrozen(ROLE_POLICY[type]));
});

test("screen announcements are host-only", () => {
  for (const type of SCREEN) {
    assert.deepEqual([...allowedRoles(type)], ["host"]);
    assert.equal(isRoleAllowed(type, "host"), true);
    assert.equal(isRoleAllowed(type, "participant"), false);
  }
});

test("every other catalog type allows both roles", () => {
  for (const type of MESSAGE_TYPES) {
    if (SCREEN.includes(type)) continue;
    assert.equal(isRoleAllowed(type, "host"), true, type);
    assert.equal(isRoleAllowed(type, "participant"), true, type);
  }
});

test("an unknown role is never allowed", () => {
  for (const type of MESSAGE_TYPES) {
    assert.equal(isRoleAllowed(type, "observer" as Role), false, type);
  }
});
