/**
 * Behaviour every MeetingEngine implementation must satisfy, whatever delivers the media. Each implementation
 * runs this suite with its own harness.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MeetingError } from "../../src/public/errors.js";
import type { MeetingEngine } from "../../src/public/types.js";
import { flush, testUlid } from "../support/fakeRealtime.js";
import { type EngineHarness, eventsOfType, recordEvents } from "../support/harness.js";

async function rejection(promise: Promise<unknown>): Promise<MeetingError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(MeetingError);
    return error as MeetingError;
  }
  throw new Error("expected the promise to reject");
}

export function describeMeetingEngineContract(name: string, makeHarness: () => EngineHarness): void {
  describe(`MeetingEngine contract (${name})`, () => {
    let h: EngineHarness;

    beforeEach(() => {
      h = makeHarness();
    });

    afterEach(() => {
      vi.useRealTimers();
      expect(h.realtime.handlerErrors).toEqual([]);
      h.cleanup();
    });

    async function joined(role: "host" | "participant" = "participant"): Promise<MeetingEngine> {
      const engine = h.createEngine({ role });
      await engine.join();
      return engine;
    }

    describe("MeetingEngine contract › lifecycle", () => {
      it("moves idle → connecting → joining → joined, with state_changed before joined", async () => {
        const engine = h.createEngine();
        const events = recordEvents(engine);
        expect(engine.state).toBe("idle");
        await engine.join();
        expect(engine.state).toBe("joined");
        expect(events.map((e) => (e.type === "state_changed" ? `state:${e.event.state}` : e.type))).toEqual([
          "state:connecting",
          "state:joining",
          "state:joined",
          "joined",
        ]);
      });

      it("resolves join with self (role from the platform) and the snapshot roster", async () => {
        const presentId = testUlid();
        h.realtime.addPresent({ participantId: presentId, role: "participant", displayName: "Ada" });
        const selfId = testUlid();
        h.realtime.setDisplayName(selfId, "Grace");
        const engine = h.createEngine({ role: "host", participantId: selfId });
        const events = recordEvents(engine);
        await engine.join();
        const [joinedEvent] = eventsOfType(events, "joined");
        expect(joinedEvent?.self).toMatchObject({ id: selfId, role: "host", displayName: "Grace" });
        expect(typeof joinedEvent?.self.joinedAt).toBe("string");
        expect(joinedEvent?.participants).toEqual([
          { id: presentId, role: "participant", displayName: "Ada", media: { camera: false, microphone: false, screen: false } },
        ]);
        expect(engine.self).toEqual(joinedEvent?.self);
        expect(engine.participants).toEqual(joinedEvent?.participants);
        expect(eventsOfType(events, "participant_joined")).toEqual([]);
      });

      it("lets two engines see each other join and leave", async () => {
        const a = await joined("host");
        const aEvents = recordEvents(a);
        const b = h.createEngine();
        const bEvents = recordEvents(b);
        await b.join();
        await flush();
        const bId = b.self?.id;
        expect(eventsOfType(bEvents, "joined")[0]?.participants.map((p) => p.id)).toEqual([a.self?.id]);
        expect(eventsOfType(aEvents, "participant_joined").map((e) => e.participant.id)).toEqual([bId]);
        expect(a.participants.map((p) => p.id)).toEqual([bId]);

        await b.leave();
        await flush();
        expect(eventsOfType(aEvents, "participant_left")).toEqual([{ participantId: bId, reason: "left" }]);
        expect(a.participants).toEqual([]);
      });

      it("leaves: joined → leaving → closed(left)", async () => {
        const engine = await joined();
        const events = recordEvents(engine);
        await engine.leave();
        expect(engine.state).toBe("closed");
        expect(eventsOfType(events, "state_changed").map((e) => e.state)).toEqual(["leaving", "closed"]);
        expect(eventsOfType(events, "closed")).toEqual([{ reason: "left" }]);
        expect(h.realtime.socketFor().sentTypes()).toContain("participant.leave");
      });

      it("returns the in-flight promise for a second leave()", async () => {
        const engine = await joined();
        const first = engine.leave();
        const second = engine.leave();
        await Promise.all([first, second]);
        expect(engine.state).toBe("closed");
      });

      it("treats leave() in idle as a no-op", async () => {
        const engine = h.createEngine();
        const events = recordEvents(engine);
        await engine.leave();
        expect(engine.state).toBe("idle");
        expect(events).toEqual([]);
      });

      it("cancels a join in progress when leave() is called while connecting", async () => {
        const engine = h.createEngine();
        const events = recordEvents(engine);
        const join = engine.join();
        await engine.leave();
        const error = await rejection(join);
        expect(error.code).toBe("join_cancelled");
        expect(engine.state).toBe("closed");
        expect(eventsOfType(events, "closed")).toEqual([{ reason: "join_failed", error }]);
      });

      it("cancels a join in progress when leave() is called while joining", async () => {
        h.realtime.holdWelcome = true;
        const engine = h.createEngine();
        const join = engine.join();
        await flush();
        expect(engine.state).toBe("joining");
        await engine.leave();
        expect((await rejection(join)).code).toBe("join_cancelled");
      });

      it("closes with meeting_ended when the meeting ends while joined", async () => {
        const engine = await joined();
        const events = recordEvents(engine);
        h.realtime.endMeeting();
        await flush();
        expect(engine.state).toBe("closed");
        expect(eventsOfType(events, "closed")).toEqual([{ reason: "meeting_ended" }]);
      });

      it("closes with meeting_ended when the meeting is terminated while joined", async () => {
        const engine = await joined();
        const events = recordEvents(engine);
        h.realtime.endMeeting("terminated");
        await flush();
        expect(eventsOfType(events, "closed")).toEqual([{ reason: "meeting_ended" }]);
      });

      it("closes with connection_lost after an unexpected drop, exactly once", async () => {
        const engine = await joined();
        const events = recordEvents(engine);
        h.realtime.dropWithoutClose();
        await flush();
        await engine.leave();
        const closed = eventsOfType(events, "closed");
        expect(closed).toHaveLength(1);
        expect(closed[0]?.reason).toBe("connection_lost");
        expect(closed[0]?.error?.code).toBe("connection_lost");
      });

      it("falls back to closed(left) 5 s after leave() when the platform never closes", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        h.realtime.ignoreLeave = true;
        const engine = await joined();
        const events = recordEvents(engine);
        const leave = engine.leave();
        await flush();
        expect(engine.state).toBe("leaving");
        await vi.advanceTimersByTimeAsync(4999);
        expect(engine.state).toBe("leaving");
        await vi.advanceTimersByTimeAsync(1);
        await leave;
        expect(eventsOfType(events, "closed")).toEqual([{ reason: "left" }]);
      });
    });

    describe("MeetingEngine contract › events", () => {
      it("keeps delivering to other listeners when one throws", async () => {
        const engine = h.createEngine();
        const seen: string[] = [];
        engine.on("joined", () => {
          throw new Error("listener failure");
        });
        engine.on("joined", () => seen.push("second"));
        await engine.join();
        expect(seen).toEqual(["second"]);
        expect(engine.state).toBe("joined");
      });

      it("unsubscribes with the returned function", async () => {
        const engine = h.createEngine();
        const seen: string[] = [];
        const off = engine.on("state_changed", (e) => seen.push(e.state));
        off();
        await engine.join();
        expect(seen).toEqual([]);
      });

      it("reports media changes, reconnects, and leave reasons for present participants", async () => {
        const otherId = testUlid();
        h.realtime.addPresent({ participantId: otherId });
        const engine = await joined();
        const events = recordEvents(engine);

        h.realtime.virtualMedia(otherId, "camera", true);
        h.realtime.virtualMedia(otherId, "camera", true);
        h.realtime.sendMessage("participant.reconnected", {}, otherId);
        h.realtime.virtualLeave(otherId, "future_reason");
        await flush();

        expect(eventsOfType(events, "participant_media_changed")).toEqual([
          { participantId: otherId, kind: "camera", enabled: true },
        ]);
        expect(eventsOfType(events, "participant_reconnected")).toEqual([{ participantId: otherId }]);
        expect(eventsOfType(events, "participant_left")).toEqual([{ participantId: otherId, reason: "other" }]);
      });

      it("does not repeat participant_joined for a participant already present", async () => {
        const engine = await joined();
        const events = recordEvents(engine);
        const otherId = testUlid();
        h.realtime.virtualJoin({ participantId: otherId });
        h.realtime.virtualJoin({ participantId: otherId, displayName: "Renamed" });
        await flush();
        expect(eventsOfType(events, "participant_joined")).toHaveLength(1);
        expect(engine.participants[0]?.displayName).toBe("Renamed");
      });

      it("never puts the join token in an event payload", async () => {
        const token = h.tokenFor("host");
        const engine = h.createEngine({ token });
        const events = recordEvents(engine);
        await engine.join();
        await engine.enableCamera();
        h.realtime.closeWith(4011);
        await flush();
        const serialized = JSON.stringify(events);
        expect(serialized).not.toContain(token);
        expect(serialized).not.toContain(token.split(".")[1]);
      });
    });

    describe("MeetingEngine contract › errors", () => {
      it.each([
        [4001, "join_token_invalid"],
        [4002, "join_token_expired"],
        [4003, "origin_not_allowed"],
        [4029, "rate_limited"],
        [4503, "service_unavailable"],
      ] as const)("rejects join when the platform closes with %i", async (code, expected) => {
        h.realtime.nextHandshake({ kind: "close", code });
        const engine = h.createEngine();
        const events = recordEvents(engine);
        const error = await rejection(engine.join());
        expect(error.code).toBe(expected);
        expect(eventsOfType(events, "closed")).toEqual([{ reason: "join_failed", error }]);
      });

      it("rejects join with connection_failed when the connection is refused", async () => {
        h.realtime.nextHandshake({ kind: "refuse" });
        expect((await rejection(h.createEngine().join())).code).toBe("connection_failed");
      });

      it("rejects join with connection_failed when the socket cannot be created", async () => {
        h.realtime.nextHandshake({ kind: "throw" });
        expect((await rejection(h.createEngine().join())).code).toBe("connection_failed");
      });

      it("rejects join with connection_failed when another subprotocol is negotiated", async () => {
        h.realtime.nextHandshake({ kind: "protocol", protocol: "something.else" });
        expect((await rejection(h.createEngine().join())).code).toBe("connection_failed");
      });

      it("rejects join with meeting_ended when the meeting ends during join", async () => {
        h.realtime.holdWelcome = true;
        const engine = h.createEngine();
        const join = engine.join();
        await flush();
        h.realtime.sendMessage("meeting.ended", { endedAt: "2026-09-28T11:00:00Z" }, testUlid());
        expect((await rejection(join)).code).toBe("meeting_ended");
      });

      it.each([
        ["rate_limited", "rate_limited"],
        ["service_unavailable", "service_unavailable"],
        ["brand_new_code", "protocol_error"],
      ])("rejects join when the platform rejects the join with %s", async (code, expected) => {
        h.realtime.holdWelcome = true;
        const participantId = testUlid();
        const engine = h.createEngine({ participantId });
        const events = recordEvents(engine);
        const join = engine.join();
        await flush();
        expect(engine.state).toBe("joining");
        h.realtime.sendMessage("session.rejected", { code }, participantId);
        expect((await rejection(join)).code).toBe(expected);
        expect(engine.state).toBe("closed");
        const closed = eventsOfType(events, "closed");
        expect(closed).toHaveLength(1);
        expect(closed[0]?.reason).toBe("join_failed");
        expect(closed[0]?.error?.code).toBe(expected);
        expect(eventsOfType(events, "error")).toEqual([]);
      });

      it("rejects join with join_timeout after joinTimeoutMs", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        h.realtime.holdWelcome = true;
        const engine = h.createEngine({ joinTimeoutMs: 1000 });
        const join = engine.join();
        const result = rejection(join);
        await flush();
        await vi.advanceTimersByTimeAsync(1000);
        expect((await result).code).toBe("join_timeout");
        expect(engine.state).toBe("closed");
      });

      it("rejects a second join with already_joined and a join after close with engine_closed", async () => {
        const engine = h.createEngine();
        const join = engine.join();
        expect((await rejection(engine.join())).code).toBe("already_joined");
        await join;
        expect((await rejection(engine.join())).code).toBe("already_joined");
        await engine.leave();
        expect((await rejection(engine.join())).code).toBe("engine_closed");
      });

      it("emits protocol_error for an invalid inbound frame and keeps the connection", async () => {
        const engine = await joined();
        const events = recordEvents(engine);
        h.realtime.send("{not json");
        await flush();
        expect(eventsOfType(events, "error").map((e) => e.error.code)).toEqual(["protocol_error"]);
        expect(engine.state).toBe("joined");
      });

      it("maps session.rejected codes to error events", async () => {
        const engine = await joined();
        const events = recordEvents(engine);
        const self = engine.self?.id ?? "";
        for (const code of ["rate_limited", "service_unavailable", "target_not_present", "brand_new_code"]) {
          h.realtime.sendMessage("session.rejected", { code }, self);
        }
        await flush();
        expect(eventsOfType(events, "error").map((e) => e.error.code)).toEqual([
          "rate_limited",
          "service_unavailable",
          "protocol_error",
          "protocol_error",
        ]);
      });

      it("closes with session_replaced when the same participant joins elsewhere", async () => {
        const selfId = testUlid();
        const first = h.createEngine({ participantId: selfId });
        const events = recordEvents(first);
        await first.join();
        const second = h.createEngine({ participantId: selfId });
        await second.join();
        await flush();
        const closed = eventsOfType(events, "closed");
        expect(closed.map((e) => [e.reason, e.error?.code])).toEqual([["session_replaced", "session_replaced"]]);
      });
    });

    describe("MeetingEngine contract › media", () => {
      it.each([
        ["enableCamera", "media.camera.started", "camera", true],
        ["unmute", "media.microphone.started", "microphone", true],
        ["startScreenShare", "media.screen.started", "screen", true],
      ] as const)("%s announces %s and the peer sees the change", async (method, frame, kind, enabled) => {
        const host = await joined("host");
        const peer = await joined();
        const peerEvents = recordEvents(peer);
        await host[method]();
        await flush();
        expect(h.realtime.socketFor(host.self?.id).sentTypes()).toContain(frame);
        expect(eventsOfType(peerEvents, "participant_media_changed")).toEqual([
          { participantId: host.self?.id, kind, enabled },
        ]);
      });

      it.each([
        ["enableCamera", "disableCamera", "media.camera.stopped", "camera"],
        ["unmute", "mute", "media.microphone.stopped", "microphone"],
        ["startScreenShare", "stopScreenShare", "media.screen.stopped", "screen"],
      ] as const)("%s then %s announces %s", async (on, off, frame, kind) => {
        const host = await joined("host");
        const peer = await joined();
        await host[on]();
        await flush();
        const peerEvents = recordEvents(peer);
        await host[off]();
        await flush();
        expect(h.realtime.socketFor(host.self?.id).sentTypes()).toContain(frame);
        expect(eventsOfType(peerEvents, "participant_media_changed")).toEqual([
          { participantId: host.self?.id, kind, enabled: false },
        ]);
        expect(host.localMediaState[kind]).toBe(false);
      });

      it("rejects media methods with not_joined before join and after leave, without capturing", async () => {
        const engine = h.createEngine({ role: "host" });
        for (const method of ["enableCamera", "unmute", "startScreenShare", "disableCamera", "mute", "stopScreenShare"] as const) {
          expect((await rejection(engine[method]())).code).toBe("not_joined");
        }
        await engine.join();
        await engine.leave();
        expect((await rejection(engine.enableCamera())).code).toBe("not_joined");
        expect(h.media.calls).toEqual({ getUserMedia: 0, getDisplayMedia: 0 });
      });

      it("rejects screen share for a participant with not_permitted before any picker", async () => {
        const engine = await joined("participant");
        expect((await rejection(engine.startScreenShare())).code).toBe("not_permitted");
        expect(h.media.calls.getDisplayMedia).toBe(0);
        expect(h.realtime.socketFor(engine.self?.id).sentTypes()).not.toContain("media.screen.started");
      });

      it("rolls back a screen share the platform rejects and reports not_permitted", async () => {
        const host = await joined("host");
        const events = recordEvents(host);
        h.realtime.rejectNext("role_not_allowed");
        await host.startScreenShare();
        await flush();
        expect(host.localMediaState.screen).toBe(false);
        expect(host.localMedia.screen).toBeNull();
        expect(h.media.liveTracks("screen")).toBe(0);
        expect(eventsOfType(events, "error").map((e) => e.error.code)).toEqual(["not_permitted"]);
        expect(eventsOfType(events, "local_media_changed").map((e) => [e.kind, e.enabled])).toEqual([
          ["screen", true],
          ["screen", false],
        ]);
      });

      it("leaves the peer's view unchanged when capture permission is denied", async () => {
        const host = await joined("host");
        const peer = await joined();
        const peerEvents = recordEvents(peer);
        h.media.failNext("camera", "NotAllowedError");
        expect((await rejection(host.enableCamera())).code).toBe("permission_denied");
        await flush();
        expect(host.localMediaState.camera).toBe(false);
        expect(eventsOfType(peerEvents, "participant_media_changed")).toEqual([]);
      });

      it("includes media of participants already present in joined.participants", async () => {
        const otherId = testUlid();
        h.realtime.addPresent({ participantId: otherId, role: "host", media: { camera: true, screen: true } });
        const engine = h.createEngine();
        const events = recordEvents(engine);
        await engine.join();
        expect(eventsOfType(events, "joined")[0]?.participants[0]?.media).toEqual({
          camera: true,
          microphone: false,
          screen: true,
        });
      });

      it("releases every capture on leave", async () => {
        const host = await joined("host");
        await host.enableCamera();
        await host.unmute();
        await host.startScreenShare();
        expect(h.media.liveTracks()).toBe(3);
        await host.leave();
        expect(h.media.liveTracks()).toBe(0);
        expect(host.localMediaState).toEqual({ camera: false, microphone: false, screen: false });
      });
    });

    describe("MeetingEngine contract › dispose", () => {
      it("emits nothing, sends no leave, releases devices, and is idempotent", async () => {
        const engine = await joined("host");
        await engine.enableCamera();
        const events = recordEvents(engine);
        engine.dispose();
        engine.dispose();
        await flush();
        expect(engine.state).toBe("closed");
        expect(events).toEqual([]);
        expect(h.realtime.socketFor(engine.self?.id).sentTypes()).not.toContain("participant.leave");
        expect(h.media.liveTracks()).toBe(0);
        expect((await rejection(engine.join())).code).toBe("engine_closed");
      });

      it("clears listeners", async () => {
        const engine = h.createEngine();
        const seen: string[] = [];
        engine.on("state_changed", (e) => seen.push(e.state));
        engine.dispose();
        await engine.leave();
        expect(seen).toEqual([]);
      });

      it("cancels a join in progress without emitting", async () => {
        const engine = h.createEngine();
        const join = engine.join();
        const events = recordEvents(engine);
        engine.dispose();
        expect((await rejection(join)).code).toBe("join_cancelled");
        expect(events).toEqual([]);
      });
    });
  });
}
