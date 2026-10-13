import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MeetingEngine } from "../src/public/types.js";
import { testUlid } from "./support/fakeRealtime.js";
import { type EngineHarness, type RecordedEvent, createP2PHarness, eventsOfType, recordEvents } from "./support/harness.js";
import { settle } from "./support/p2p.js";

type Member = { id: string; engine: MeetingEngine; events: RecordedEvent[] };

describe("peer media › one other participant", () => {
  let h: EngineHarness;
  /** Ordered `from>to` pairs that may exchange offers in the current test. */
  let allowedOffers: Set<string>;

  beforeEach(() => {
    h = createP2PHarness();
    allowedOffers = new Set();
  });

  afterEach(() => {
    expect(h.realtime.handlerErrors).toEqual([]);
    const offers = h.realtime.peerFrames.filter((f) => f.type === "webrtc.offer").map((f) => `${f.from}>${f.to}`);
    expect(offers.filter((offer) => !allowedOffers.has(offer)), "offers to a participant that is not pairing").toEqual([]);
    h.cleanup();
  });

  /** Participant IDs in ascending order, so the first of any two is the offerer. */
  function sortedIds(count: number): string[] {
    return Array.from({ length: count }, () => testUlid()).sort();
  }

  function allowPair(low: string, high: string): void {
    allowedOffers.add(`${low}>${high}`);
  }

  async function join(id: string): Promise<Member> {
    const engine = h.createEngine({ participantId: id });
    const events = recordEvents(engine, { media: true });
    await engine.join();
    await settle();
    return { id, engine, events };
  }

  const limitErrors = (m: Member) => eventsOfType(m.events, "error").filter((e) => e.error.code === "media_participant_limit");

  const statusEvents = (m: Member, participantId: string) =>
    eventsOfType(m.events, "media_connection_changed")
      .filter((e) => e.participantId === participantId)
      .map((e) => e.status);

  it("a third participant joining a connected pair gets the limit error and no connection; the pair keeps its media", async () => {
    const [a, b, c] = sortedIds(3) as [string, string, string];
    allowPair(a, b);
    const ma = await join(a);
    const mb = await join(b);
    await Promise.all([ma.engine.enableCamera(), mb.engine.enableCamera()]);
    await settle();
    expect(ma.engine.mediaConnectionStatus(b)).toBe("connected");
    const camera = ma.engine.remoteMedia(b).camera;
    const connections = h.network.connections.length;

    const mc = await join(c);
    await settle();
    expect(h.network.connections).toHaveLength(connections);
    expect(ma.engine.mediaConnectionStatus(b)).toBe("connected");
    expect(ma.engine.remoteMedia(b).camera).toBe(camera);
    expect(limitErrors(mc)).toHaveLength(2);
    expect(limitErrors(ma)).toHaveLength(1);
    expect(limitErrors(mb)).toHaveLength(1);
    for (const m of [ma, mb]) {
      expect(m.engine.mediaConnectionStatus(c)).toBeNull();
      expect(statusEvents(m, c)).toEqual([]);
    }
    expect(mc.engine.mediaConnectionStatus(a)).toBeNull();
    expect(mc.engine.mediaConnectionStatus(b)).toBeNull();
    expect(mc.engine.state).toBe("joined");
  });

  it("a joiner with the lowest ID among three or more creates no connection and reports no status", async () => {
    const [a, b, c] = sortedIds(3) as [string, string, string];
    allowPair(b, c);
    await join(b);
    await join(c);
    const connections = h.network.connections.length;

    const ma = await join(a);
    await settle();
    expect(h.network.connections).toHaveLength(connections);
    expect(eventsOfType(ma.events, "media_connection_changed")).toEqual([]);
    expect(ma.engine.mediaConnectionStatus(b)).toBeNull();
    expect(ma.engine.mediaConnectionStatus(c)).toBeNull();
    expect(limitErrors(ma).map((e) => e.error.code)).toEqual(["media_participant_limit", "media_participant_limit"]);
    expect(ma.engine.state).toBe("joined");
  });

  it("a third participant appearing before the pair connected abandons the link silently", async () => {
    h.network.autoConnect = false;
    const [a, b, c] = sortedIds(3) as [string, string, string];
    allowPair(a, b);
    const ma = await join(a);
    const mb = await join(b);
    expect(ma.engine.mediaConnectionStatus(b)).toBe("connecting");
    expect(h.network.open().length).toBeGreaterThan(0);

    const mc = await join(c);
    await settle();
    expect(h.network.open()).toEqual([]);
    expect(h.realtime.peerReports.filter((r) => r.type === "webrtc.failed")).toEqual([]);
    expect(ma.engine.mediaConnectionStatus(b)).toBeNull();
    expect(mb.engine.mediaConnectionStatus(a)).toBeNull();
    expect(statusEvents(ma, b)).toEqual(["connecting", null]);
    for (const m of [ma, mb, mc]) expect(limitErrors(m)).toHaveLength(2);
  });

  it("when one of three leaves, the remaining two pair and connect, offerer by ID", async () => {
    h.network.autoConnect = false;
    const [a, b, c] = sortedIds(3) as [string, string, string];
    allowPair(a, b);
    allowPair(b, c);
    const ma = await join(a);
    const mb = await join(b);
    const mc = await join(c);
    expect(h.network.open()).toEqual([]);
    h.network.autoConnect = true;

    await ma.engine.leave();
    await settle();
    expect(mb.engine.mediaConnectionStatus(c)).toBe("connected");
    expect(mc.engine.mediaConnectionStatus(b)).toBe("connected");
    expect(h.realtime.peerFrames.filter((f) => f.type === "webrtc.offer").at(-1)).toMatchObject({ from: b, to: c, delivered: true });
    expect(h.network.open()).toHaveLength(2);
  });

  it("with four present, a leave that leaves three creates no connection", async () => {
    const [a, b, c, d] = sortedIds(4) as [string, string, string, string];
    allowPair(a, b);
    const ma = await join(a);
    const mb = await join(b);
    await join(c);
    const md = await join(d);
    const connections = h.network.connections.length;

    await md.engine.leave();
    await settle();
    expect(h.network.connections).toHaveLength(connections);
    expect(ma.engine.mediaConnectionStatus(b)).toBe("connected");
    expect(ma.engine.mediaConnectionStatus(c)).toBeNull();
    expect(mb.engine.mediaConnectionStatus(c)).toBeNull();
  });

  it("reports the limit again for each new presence of the same participant", async () => {
    const [a, b, c] = sortedIds(3) as [string, string, string];
    allowPair(a, b);
    const ma = await join(a);
    await join(b);
    const first = await join(c);
    expect(limitErrors(ma)).toHaveLength(1);

    await first.engine.leave();
    await settle();
    const again = await join(c);
    await settle();
    expect(limitErrors(ma)).toHaveLength(2);
    expect(limitErrors(again)).toHaveLength(2);
  });
});
