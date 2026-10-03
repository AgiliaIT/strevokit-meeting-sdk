import assert from "node:assert/strict";
import test from "node:test";
import { INVALID_SAMPLES, VALID_SAMPLES, expectedOutcome } from "../src/conformance/index.js";
import { MESSAGE_TYPES, REJECTION_CODES, decodeSignalingFrame, parseSignalingMessage } from "../src/index.js";
import type { ParseResult, ReceiveDirection } from "../src/index.js";

const DIRECTIONS: Array<ReceiveDirection | undefined> = [undefined, "client_to_server", "server_to_client"];

function run(sample: (typeof INVALID_SAMPLES)[number], direction?: ReceiveDirection): ParseResult {
  const options = direction ? { direction } : undefined;
  return sample.inputKind === "frame"
    ? decodeSignalingFrame(sample.input, options)
    : parseSignalingMessage(sample.input, options);
}

test("every valid sample matches expectedOutcome in every direction", () => {
  for (const sample of VALID_SAMPLES) {
    for (const direction of DIRECTIONS) {
      const expected = expectedOutcome(sample, direction);
      const result = parseSignalingMessage(sample.input, direction ? { direction } : undefined);
      assert.equal(result.ok, expected.ok, `${sample.name} (${direction ?? "none"})`);
      if (!result.ok && !expected.ok) assert.equal(result.error.code, expected.code, sample.name);
    }
  }
});

test("valid samples also pass through the frame entry point", () => {
  for (const sample of VALID_SAMPLES) {
    const result = decodeSignalingFrame(JSON.stringify(sample.input));
    assert.equal(result.ok, true, sample.name);
  }
});

test("every invalid sample is rejected with its expected code, detail and field", () => {
  for (const sample of INVALID_SAMPLES) {
    const result = run(sample, sample.direction);
    assert.equal(result.ok, false, sample.name);
    if (result.ok) continue;
    assert.equal(result.error.code, sample.expectedCode, sample.name);
    if (sample.expectedDetail) assert.equal(result.error.detail, sample.expectedDetail, sample.name);
    if (sample.expectedField) assert.equal(result.error.field, sample.expectedField, sample.name);
    assert.deepEqual(expectedOutcome(sample), { ok: false, code: sample.expectedCode }, sample.name);
  }
});

test("invalid samples match expectedOutcome for consumers in a fixed direction", () => {
  for (const direction of ["client_to_server", "server_to_client"] as const) {
    for (const sample of INVALID_SAMPLES) {
      if (sample.direction && sample.direction !== direction) continue;
      const expected = expectedOutcome(sample, direction);
      const result = run(sample, direction);
      assert.equal(result.ok, false, sample.name);
      if (!result.ok && !expected.ok) assert.equal(result.error.code, expected.code, `${sample.name} (${direction})`);
    }
  }
});

test("coverage: every type has a valid sample and every code an invalid sample", () => {
  const typesCovered = new Set(VALID_SAMPLES.map((sample) => sample.input.type));
  for (const type of MESSAGE_TYPES) assert.ok(typesCovered.has(type), `no valid sample for ${type}`);
  const codesCovered = new Set(INVALID_SAMPLES.map((sample) => sample.expectedCode));
  for (const code of REJECTION_CODES) assert.ok(codesCovered.has(code), `no invalid sample for ${code}`);
});

test("sample names are unique", () => {
  const names = [...VALID_SAMPLES, ...INVALID_SAMPLES].map((sample) => sample.name);
  assert.equal(new Set(names).size, names.length);
});
