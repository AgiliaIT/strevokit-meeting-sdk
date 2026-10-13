import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { diffApiReports } from "../scripts/apiDiff.mjs";

const REPORT = readFileSync(join(import.meta.dirname, "..", "etc", "meeting-sdk.api.md"), "utf8").replace(/\r\n/g, "\n");

/** The real report with one edit applied; fails loudly if the edit no longer applies. */
function edited(search: string | RegExp, replacement: string): string {
  const next = REPORT.replace(search, replacement);
  if (next === REPORT) throw new Error(`fixture edit did not apply: ${String(search)}`);
  return next;
}

describe("diffApiReports", () => {
  it("reports no changes for an identical report", () => {
    expect(diffApiReports(REPORT, REPORT)).toEqual({ breaking: [], additive: [] });
  });

  it("ignores line-ending differences", () => {
    expect(diffApiReports(REPORT.replace(/\n/g, "\r\n"), REPORT)).toEqual({ breaking: [], additive: [] });
  });

  it("parses every exported declaration", () => {
    const removedAll = edited(/```ts\n[\s\S]*?\n```/, "```ts\n```");
    expect(diffApiReports(REPORT, removedAll).breaking).toHaveLength(21);
  });

  it("has only additions since 0.1.0", () => {
    const released = readFileSync(join(import.meta.dirname, "fixtures", "meeting-sdk-0.1.0.api.md"), "utf8");
    const { breaking, additive } = diffApiReports(released, REPORT);
    expect(breaking).toEqual([]);
    expect([...additive].sort()).toEqual(
      [
        "added MediaConnectionStatus",
        "added MediaDeviceOptions",
        "added RemoteMedia",
        "added optional parameter to MeetingEngine.enableCamera",
        "added optional parameter to MeetingEngine.unmute",
        "added MeetingEngine.mediaConnectionStatus",
        "added MeetingEngine.remoteMedia",
        "added MeetingEventMap.media_connection_changed",
        "added MeetingEventMap.remote_media_changed",
        'added MeetingErrorCode "media_connection_failed"',
        'added MeetingErrorCode "media_participant_limit"',
      ].sort(),
    );
  });

  it("detects a member removed from one declaration while another declaration has the same line", () => {
    const current = edited(/(export interface Participant \{[\s\S]*?)\n {4}readonly id: string;/, "$1");
    expect(diffApiReports(REPORT, current).breaking).toEqual(["removed Participant.id"]);
  });

  it("treats an added error code as additive and a removed one as breaking", () => {
    const added = edited('| "media_participant_limit";', '| "media_participant_limit" | "brand_new_code";');
    expect(diffApiReports(REPORT, added)).toEqual({ breaking: [], additive: ['added MeetingErrorCode "brand_new_code"'] });

    const removed = edited('"rate_limited" | ', "");
    expect(diffApiReports(REPORT, removed).breaking).toEqual(['removed MeetingErrorCode "rate_limited"']);
  });

  it("treats an added optional event field as additive and a removed field as breaking", () => {
    const added = edited("readonly error?: MeetingError;", "readonly error?: MeetingError;\n        readonly at?: string;");
    expect(diffApiReports(REPORT, added)).toEqual({ breaking: [], additive: ["added MeetingEventMap.closed.at"] });

    const removed = edited("\n        readonly previous: ConnectionState;", "");
    expect(diffApiReports(REPORT, removed).breaking).toEqual(["removed MeetingEventMap.state_changed.previous"]);
  });

  it("treats a type change after an event payload's closing brace as breaking", () => {
    const nullable = edited("readonly error?: MeetingError;\n    };", "readonly error?: MeetingError;\n    } | null;");
    expect(diffApiReports(REPORT, nullable)).toEqual({ breaking: ["changed MeetingEventMap.closed"], additive: [] });

    const union = edited(
      "readonly participants: readonly Participant[];\n    };",
      "readonly participants: readonly Participant[];\n    } | {\n        readonly self: SelfParticipant;\n    };",
    );
    expect(diffApiReports(REPORT, union)).toEqual({ breaking: ["changed MeetingEventMap.joined"], additive: [] });
  });

  it("treats a new required option as breaking and a new optional option as additive", () => {
    const required = edited("    token: string;\n", "    token: string;\n    region: string;\n");
    expect(diffApiReports(REPORT, required).breaking).toEqual(["added required MeetingEngineOptions.region"]);

    const optional = edited("    token: string;\n", "    token: string;\n    region?: string;\n");
    expect(diffApiReports(REPORT, optional)).toEqual({ breaking: [], additive: ["added MeetingEngineOptions.region"] });
  });

  it("treats a new engine method as additive and a changed signature as breaking", () => {
    const added = edited("    leave(): Promise<void>;\n", "    leave(): Promise<void>;\n    reconnect(): Promise<void>;\n");
    expect(diffApiReports(REPORT, added)).toEqual({ breaking: [], additive: ["added MeetingEngine.reconnect"] });

    const changed = edited("    join(): Promise<void>;", "    join(timeoutMs: number): Promise<void>;");
    expect(diffApiReports(REPORT, changed).breaking).toEqual(["changed MeetingEngine.join"]);
  });

  it("treats an appended optional parameter as additive, and a required or reordered one as breaking", () => {
    const optional = edited("    join(): Promise<void>;", "    join(options?: { readonly fast?: boolean }): Promise<void>;");
    expect(diffApiReports(REPORT, optional)).toEqual({
      breaking: [],
      additive: ["added optional parameter to MeetingEngine.join"],
    });

    const required = edited("    join(): Promise<void>;", "    join(options: { readonly fast?: boolean }): Promise<void>;");
    expect(diffApiReports(REPORT, required).breaking).toEqual(["changed MeetingEngine.join"]);

    const returnType = edited("    join(): Promise<void>;", "    join(options?: string): Promise<boolean>;");
    expect(diffApiReports(REPORT, returnType).breaking).toEqual(["changed MeetingEngine.join"]);

    const base = edited("    join(): Promise<void>;", "    join(a?: string): Promise<void>;");
    const reordered = edited("    join(): Promise<void>;", "    join(b?: number, a?: string): Promise<void>;");
    expect(diffApiReports(base, reordered).breaking).toEqual(["changed MeetingEngine.join"]);
  });

  it("treats a removed declaration as breaking and a new declaration as additive", () => {
    const removed = edited(/\/\/ @public\nexport type ParticipantRole = [^\n]*\n/, "");
    expect(diffApiReports(REPORT, removed).breaking).toEqual(["removed ParticipantRole"]);

    const added = edited("// @public\nexport type ParticipantRole", '// @public\nexport type RoomId = string;\n\n// @public\nexport type ParticipantRole');
    expect(diffApiReports(REPORT, added)).toEqual({ breaking: [], additive: ["added RoomId"] });
  });

  it("treats a narrowed non-union alias as breaking", () => {
    const changed = edited("export type MeetingEventType = keyof MeetingEventMap;", 'export type MeetingEventType = "joined";');
    expect(diffApiReports(REPORT, changed).breaking).toEqual(["changed MeetingEventType"]);
  });
});
