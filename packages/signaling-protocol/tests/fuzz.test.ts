import assert from "node:assert/strict";
import test from "node:test";
import { MESSAGE_TYPES, decodeSignalingFrame, parseSignalingMessage } from "../src/index.js";
import { validEnvelope } from "./helpers.js";

const SEED = 0x5eed_2026;
const ITERATIONS = 12_000;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeGenerators(rand: () => number) {
  const int = (max: number) => Math.floor(rand() * max);
  const pick = <T>(items: readonly T[]): T => items[int(items.length)] as T;

  const randomString = (): string => {
    const alphabet = ["a", "Z", "0", " ", ".", "_", "\"", "\\", "\u0000", "é", "€", "😀", "\ud800", "{", "["];
    let s = "";
    const length = int(40);
    for (let i = 0; i < length; i++) s += pick(alphabet);
    return s;
  };

  const randomJson = (depth: number): unknown => {
    const kind = int(depth > 3 ? 5 : 7);
    switch (kind) {
      case 0: return null;
      case 1: return rand() < 0.5;
      case 2: return pick([0, 1, -1, 1.5, 2, 1e308, -0, Number.MAX_SAFE_INTEGER]);
      case 3: return randomString();
      case 4: return pick(["participant.join", "webrtc.offer", "01JQBBBBBBBBBBBBBBBBBBBBBB", ""]);
      case 5: return Array.from({ length: int(4) }, () => randomJson(depth + 1));
      default: {
        const obj: Record<string, unknown> = {};
        const keys = ["version", "type", "meetingId", "participantId", "payload", "sdp", "candidate", "__proto__", "constructor", randomString()];
        for (let i = int(6); i > 0; i--) obj[pick(keys)] = randomJson(depth + 1);
        return obj;
      }
    }
  };

  const mutateValid = (): unknown => {
    const message = validEnvelope(pick(MESSAGE_TYPES));
    const payload = message.payload as Record<string, unknown>;
    const envelopeKeys = Object.keys(message);
    const payloadKeys = Object.keys(payload);
    switch (int(8)) {
      case 0: delete message[pick(envelopeKeys)]; break;
      case 1: message[pick(envelopeKeys)] = randomJson(2); break;
      case 2: if (payloadKeys.length) delete payload[pick(payloadKeys)]; break;
      case 3: if (payloadKeys.length) payload[pick(payloadKeys)] = randomJson(2); break;
      case 4: message.type = pick(MESSAGE_TYPES); break;
      case 5: message[randomString()] = randomJson(1); break;
      case 6: payload[randomString()] = randomJson(1); break;
      default: return JSON.stringify(message).slice(0, int(200));
    }
    return message;
  };

  const hostile = (): unknown => {
    switch (int(6)) {
      case 0: return JSON.parse('{"__proto__":{"polluted":true},"version":1,"type":"participant.join"}');
      case 1: {
        const obj = validEnvelope("participant.join");
        Object.defineProperty(obj, "payload", { enumerable: true, get() { throw new Error("boom"); } });
        return obj;
      }
      case 2: {
        const obj = validEnvelope("webrtc.offer") as Record<string, unknown>;
        (obj.payload as Record<string, unknown>).self = obj;
        obj.self = obj;
        return obj;
      }
      case 3:
        return new Proxy({}, {
          get() { throw new Error("trap"); },
          getPrototypeOf() { throw new Error("trap"); },
          has() { throw new Error("trap"); },
          getOwnPropertyDescriptor() { throw new Error("trap"); },
          ownKeys() { throw new Error("trap"); },
        });
      case 4: {
        const obj = Object.create(null) as Record<string, unknown>;
        Object.assign(obj, validEnvelope("media.camera.started"));
        return obj;
      }
      default:
        return Object.assign(Object.create({ version: 1, type: "participant.join" }), { payload: {} });
    }
  };

  return { int, randomJson, randomString, mutateValid, hostile };
}

test(`fuzz: ${ITERATIONS} generated inputs never throw (seed ${SEED})`, () => {
  const rand = mulberry32(SEED);
  const gen = makeGenerators(rand);
  const protoBefore = Object.getOwnPropertyNames(Object.prototype).sort();
  let accepted = 0;

  for (let i = 0; i < ITERATIONS; i++) {
    const kind = gen.int(5);
    const input =
      kind === 0 ? gen.randomJson(0)
      : kind === 1 ? gen.mutateValid()
      : kind === 2 ? gen.randomString()
      : kind === 3 ? gen.hostile()
      : (() => { try { return JSON.stringify(gen.mutateValid()); } catch { return "{"; } })();

    let parsed;
    let decoded;
    try {
      parsed = parseSignalingMessage(input, { direction: gen.int(2) ? "client_to_server" : "server_to_client" });
      decoded = decodeSignalingFrame(input);
    } catch (error) {
      assert.fail(`iteration ${i} (seed ${SEED}) threw: ${String(error)}`);
    }
    assert.equal(typeof parsed.ok, "boolean");
    assert.equal(typeof decoded.ok, "boolean");
    if (parsed.ok) accepted++;
  }

  assert.deepEqual(Object.getOwnPropertyNames(Object.prototype).sort(), protoBefore);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  assert.ok(accepted > 0, "fuzz corpus should include some valid messages");
});
