import type { MeetingEngine } from "../../src/public/types.js";
import type { FakePeerConnection } from "./fakePeerConnection.js";
import { flush, testUlid } from "./fakeRealtime.js";
import type { EngineHarness } from "./harness.js";

/** Two participant IDs where `low` sorts before `high`, so `low` is the offerer. */
export function orderedIds(): { low: string; high: string } {
  const a = testUlid();
  const b = testUlid();
  return a < b ? { low: a, high: b } : { low: b, high: a };
}

/** Lets fake signaling, negotiation and connection steps run to completion. */
export async function settle(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i++) await flush(100);
}

export type Pair = { low: MeetingEngine; high: MeetingEngine; lowId: string; highId: string };

/** Two joined engines with camera and microphone on in both, settled. */
export async function joinedPair(
  h: EngineHarness,
  options: { devices?: boolean; lowRole?: "host" | "participant" } = {},
): Promise<Pair> {
  const { low: lowId, high: highId } = orderedIds();
  const low = h.createEngine({ participantId: lowId, role: options.lowRole ?? "participant" });
  const high = h.createEngine({ participantId: highId });
  await low.join();
  await high.join();
  if (options.devices ?? true) {
    await Promise.all([low.enableCamera(), low.unmute(), high.enableCamera(), high.unmute()]);
  }
  await settle();
  return { low, high, lowId, highId };
}

/** The open fake connection whose remote side is `other`'s connection, by link. */
export function linkedPairOf(h: EngineHarness): [FakePeerConnection, FakePeerConnection] | undefined {
  const open = h.network.open();
  for (const pc of open) {
    if (pc.linked && pc.linked.linked === pc && !pc.linked.closed) return [pc, pc.linked];
  }
  return undefined;
}

/** Decoded `webrtc.*` frames a participant's latest connection sent. */
export function sentPeerFrames(h: EngineHarness, participantId: string): { type: string; payload: Record<string, unknown> }[] {
  return h.realtime
    .socketFor(participantId)
    .sent.map((frame) => JSON.parse(frame) as { type: string; payload: Record<string, unknown> })
    .filter((message) => message.type.startsWith("webrtc."));
}
