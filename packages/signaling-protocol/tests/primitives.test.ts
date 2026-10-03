import assert from "node:assert/strict";
import test from "node:test";
import {
  codePointLength,
  isCanonicalUlid,
  isPlainObject,
  isReasonCode,
  isRfc3339UtcTimestamp,
  readOwn,
  utf8ByteLength,
} from "../src/primitives.js";

test("isCanonicalUlid accepts canonical uppercase ULIDs", () => {
  assert.equal(isCanonicalUlid("01JQBBBBBBBBBBBBBBBBBBBBBB"), true);
  assert.equal(isCanonicalUlid("01ARZ3NDEKTSV4RRFFQ69G5FAV"), true);
});

test("isCanonicalUlid rejects non-canonical values", () => {
  for (const value of [
    "01arz3ndektsv4rrffq69g5fav",
    "01ARZ3NDEKTSV4RRFFQ69G5FA",
    "01ARZ3NDEKTSV4RRFFQ69G5FAVX",
    "01ARZ3NDEKTSV4RRFFQ69G5FAI",
    "01ARZ3NDEKTSV4RRFFQ69G5FAL",
    "01ARZ3NDEKTSV4RRFFQ69G5FAO",
    "01ARZ3NDEKTSV4RRFFQ69G5FAU",
    "12345",
    "",
    12345,
    null,
    undefined,
  ]) {
    assert.equal(isCanonicalUlid(value), false, String(value));
  }
});

test("utf8ByteLength matches the UTF-8 encoding", () => {
  assert.equal(utf8ByteLength(""), 0);
  assert.equal(utf8ByteLength("abc"), 3);
  assert.equal(utf8ByteLength("é"), 2);
  assert.equal(utf8ByteLength("€"), 3);
  assert.equal(utf8ByteLength("😀"), 4);
  const mixed = "aé€😀\r\n";
  assert.equal(utf8ByteLength(mixed), Buffer.byteLength(mixed, "utf8"));
});

test("codePointLength counts surrogate pairs once", () => {
  assert.equal(codePointLength("abc"), 3);
  assert.equal(codePointLength("😀😀"), 2);
  assert.equal(codePointLength("é€"), 2);
});

test("isReasonCode enforces the pattern", () => {
  assert.equal(isReasonCode("ice_failed"), true);
  assert.equal(isReasonCode("a"), true);
  assert.equal(isReasonCode("a".repeat(64)), true);
  for (const value of ["", "Ice_failed", "1abc", "ice-failed", "a".repeat(65), " left", 5]) {
    assert.equal(isReasonCode(value), false, String(value));
  }
});

test("isRfc3339UtcTimestamp accepts UTC timestamps with real dates", () => {
  assert.equal(isRfc3339UtcTimestamp("2026-09-28T10:15:30Z"), true);
  assert.equal(isRfc3339UtcTimestamp("2026-09-28T10:15:30.123Z"), true);
  assert.equal(isRfc3339UtcTimestamp("2024-02-29T00:00:00Z"), true);
});

test("isRfc3339UtcTimestamp rejects offsets and impossible dates", () => {
  for (const value of [
    "2026-09-28T10:15:30+03:00",
    "2026-02-30T00:00:00Z",
    "2025-02-29T00:00:00Z",
    "2026-13-01T00:00:00Z",
    "2026-09-28T24:00:00Z",
    "2026-09-28 10:15:30Z",
    "2026-09-28",
    1727518530,
  ]) {
    assert.equal(isRfc3339UtcTimestamp(value), false, String(value));
  }
});

test("isPlainObject only accepts plain objects", () => {
  assert.equal(isPlainObject({}), true);
  assert.equal(isPlainObject(Object.create(null)), true);
  assert.equal(isPlainObject([]), false);
  assert.equal(isPlainObject(null), false);
  assert.equal(isPlainObject("x"), false);
  assert.equal(isPlainObject(new (class Foo {})()), false);
  assert.equal(isPlainObject(new Date()), false);
});

test("readOwn ignores inherited properties", () => {
  const obj = Object.create({ inherited: 1 }) as Record<string, unknown>;
  obj.own = 2;
  assert.equal(readOwn(obj, "own"), 2);
  assert.equal(readOwn(obj, "inherited"), undefined);
  assert.equal(readOwn({}, "toString"), undefined);
});
