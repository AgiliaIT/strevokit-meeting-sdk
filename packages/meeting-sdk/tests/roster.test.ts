import { describe, expect, it } from "vitest";
import { Roster } from "../src/internal/roster.js";

const A = "01JQ000000000000000000000A";
const B = "01JQ000000000000000000000B";
const C = "01JQ000000000000000000000C";
const OFF = { camera: false, microphone: false, screen: false };

describe("Roster snapshot", () => {
  it("buffers joined and media frames before commit, then lists them in arrival order", () => {
    const roster = new Roster();
    expect(roster.upsertJoined(B, "host", "Bea")).toBe("buffered");
    roster.setMedia(B, "camera", true);
    expect(roster.upsertJoined(A, "participant")).toBe("buffered");
    expect(roster.list()).toEqual([]);
    roster.commit();
    expect(roster.list()).toEqual([
      { id: B, role: "host", displayName: "Bea", media: { ...OFF, camera: true } },
      { id: A, role: "participant", media: OFF },
    ]);
  });

  it("upserts duplicate snapshot entries", () => {
    const roster = new Roster();
    roster.upsertJoined(A, "participant");
    roster.upsertJoined(A, "host", "Ann");
    roster.commit();
    expect(roster.list()).toEqual([{ id: A, role: "host", displayName: "Ann", media: OFF }]);
  });

  it("creates an entry for a media frame about an unknown participant before commit", () => {
    const roster = new Roster();
    roster.setMedia(C, "screen", true);
    roster.commit();
    expect(roster.list()).toEqual([{ id: C, role: "participant", media: { ...OFF, screen: true } }]);
  });
});

describe("Roster after commit", () => {
  function committed(): Roster {
    const roster = new Roster();
    roster.upsertJoined(A, "participant");
    roster.commit();
    return roster;
  }

  it("adds a new participant and silently updates a duplicate", () => {
    const roster = committed();
    expect(roster.upsertJoined(B, "participant")).toBe("added");
    expect(roster.upsertJoined(B, "host", "Bo")).toBe("updated");
    expect(roster.get(B)).toEqual({ id: B, role: "host", displayName: "Bo", media: OFF });
  });

  it("removes a participant who left", () => {
    const roster = committed();
    expect(roster.remove(A)).toBe(true);
    expect(roster.remove(A)).toBe(false);
    expect(roster.list()).toEqual([]);
  });

  it("ignores media frames for unknown participants", () => {
    const roster = committed();
    expect(roster.setMedia(C, "camera", true)).toBe(false);
    expect(roster.get(C)).toBeUndefined();
  });

  it("reports whether a media frame changed state", () => {
    const roster = committed();
    expect(roster.setMedia(A, "microphone", true)).toBe(true);
    expect(roster.setMedia(A, "microphone", true)).toBe(false);
    expect(roster.setMedia(A, "microphone", false)).toBe(true);
  });

  it("returns immutable snapshots", () => {
    const roster = committed();
    const [entry] = roster.list();
    expect(Object.isFrozen(entry)).toBe(true);
    expect(Object.isFrozen(entry?.media)).toBe(true);
    expect(Object.isFrozen(roster.list())).toBe(true);
  });

  it("clears everything", () => {
    const roster = committed();
    roster.clear();
    expect(roster.list()).toEqual([]);
  });
});
