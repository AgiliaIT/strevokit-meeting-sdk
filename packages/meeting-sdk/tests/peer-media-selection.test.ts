import type { MediaMode } from "@strevokit/signaling-protocol";
import { afterEach, describe, expect, it } from "vitest";
import { type EngineHarness, createHarness, eventsOfType, recordEvents } from "./support/harness.js";
import { orderedIds, sentPeerFrames, settle } from "./support/p2p.js";

describe("peer media › selection at welcome", () => {
  let h: EngineHarness | undefined;

  afterEach(() => {
    expect(h?.realtime.handlerErrors).toEqual([]);
    h?.cleanup();
    h = undefined;
  });

  for (const mediaMode of ["sfu", undefined] as (MediaMode | undefined)[]) {
    it(`uses signaling only when the welcome says ${mediaMode ?? "nothing"}`, async () => {
      h = createHarness(mediaMode ? { mediaMode } : {});
      const { low: lowId, high: highId } = orderedIds();
      const low = h.createEngine({ participantId: lowId });
      const high = h.createEngine({ participantId: highId });
      const lowEvents = recordEvents(low, { media: true });
      const highEvents = recordEvents(high, { media: true });
      await low.join();
      await high.join();
      await Promise.all([low.enableCamera(), low.unmute(), high.enableCamera(), high.unmute()]);
      await settle();

      expect(h.network.connections).toHaveLength(0);
      expect(sentPeerFrames(h, lowId)).toEqual([]);
      expect(sentPeerFrames(h, highId)).toEqual([]);
      for (const events of [lowEvents, highEvents]) {
        expect(eventsOfType(events, "remote_media_changed")).toEqual([]);
        expect(eventsOfType(events, "media_connection_changed")).toEqual([]);
        expect(eventsOfType(events, "error")).toEqual([]);
      }
      expect(low.remoteMedia(highId)).toEqual({ camera: null, microphone: null, screen: null });
      expect(low.mediaConnectionStatus(highId)).toBeNull();
      expect(low.participants.map((p) => p.id)).toEqual([highId]);
      expect(low.participants[0]?.media).toEqual({ camera: true, microphone: true, screen: false });
    });
  }

  it("hands the welcome's servers, credentials included, to the connection unchanged and never forces a policy", async () => {
    const iceServers = [
      { urls: ["stun:turn.example.com:3478"] },
      {
        urls: ["turn:turn.example.com:3478?transport=udp", "turn:turn.example.com:3478?transport=tcp"],
        username: `${Math.floor(Date.now() / 1000) + 600}:${"b".repeat(24)}`,
        credential: ["sample", "credential", "value"].join("-"),
      },
    ];
    h = createHarness({ mediaMode: "p2p", iceServers });
    const { low: lowId, high: highId } = orderedIds();
    const low = h.createEngine({ participantId: lowId });
    const high = h.createEngine({ participantId: highId });
    await low.join();
    await high.join();
    await settle();

    expect(h.network.connections.length).toBeGreaterThan(0);
    for (const pc of h.network.connections) {
      expect(pc.configuration.iceServers).toEqual(iceServers);
      expect(pc.configuration).not.toHaveProperty("iceTransportPolicy");
    }
  });

  it("reports unsupported_environment once and keeps presence working when direct connections are unavailable", async () => {
    h = createHarness({ mediaMode: "p2p", peerConnections: false });
    const { low: lowId, high: highId } = orderedIds();
    const low = h.createEngine({ participantId: lowId });
    const events = recordEvents(low, { media: true });
    await low.join();
    const high = h.createEngine({ participantId: highId });
    await high.join();
    await high.enableCamera();
    await settle();

    expect(eventsOfType(events, "error").map((e) => e.error.code)).toEqual(["unsupported_environment"]);
    expect(low.state).toBe("joined");
    expect(low.participants.map((p) => p.id)).toEqual([highId]);
    expect(low.participants[0]?.media.camera).toBe(true);
    expect(eventsOfType(events, "media_connection_changed")).toEqual([]);
    expect(sentPeerFrames(h, lowId)).toEqual([]);
    expect(low.remoteMedia(highId)).toEqual({ camera: null, microphone: null, screen: null });
  });
});
