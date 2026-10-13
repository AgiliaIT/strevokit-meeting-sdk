// Proves the packed tarball publishes, installs into a clean project, type-checks, and runs the quick-start flow.
import { execFileSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { build } from "esbuild";
import { bin, extract, fail, pack, readJson, root, tempDir } from "./lib.mjs";

const ALLOWED_FILES = new Set(["package.json", "README.md", "CHANGELOG.md", "dist/index.js", "dist/index.js.map", "dist/index.d.ts"]);
const REQUIRED_FILES = [...ALLOWED_FILES, "docs/api-reference.md"];
const DEPENDENCY_FIELDS = ["dependencies", "peerDependencies", "optionalDependencies", "bundleDependencies"];

const CONSUMER_SOURCE = `
import {
  createMeetingEngine,
  MeetingError,
  type CloseReason,
  type ConnectionState,
  type LocalMedia,
  type MediaDeviceOptions,
  type MediaKind,
  type MediaState,
  type MeetingEngine,
  type MeetingEngineOptions,
  type MeetingErrorCode,
  type MeetingEventListener,
  type MeetingEventMap,
  type MeetingEventType,
  type MeetingLogger,
  type Participant,
  type ParticipantLeftReason,
  type ParticipantRole,
  type SelfParticipant,
} from "@strevokit/meeting-sdk";

const logger: MeetingLogger = { debug() {}, info() {}, warn() {}, error() {} };
const options: MeetingEngineOptions = { token: "t", realtimeUrl: "wss://realtime.example.com", joinTimeoutMs: 15000, logger };
const engine: MeetingEngine = createMeetingEngine(options);
const state: ConnectionState = engine.state;
const media: MediaState = engine.localMediaState;
const local: LocalMedia = engine.localMedia;
const self: SelfParticipant | null = engine.self;
const people: readonly Participant[] = engine.participants;
const kind: MediaKind = people[0]?.media.camera ? "camera" : "screen";
const role: ParticipantRole | undefined = self?.role;
const onJoined: MeetingEventListener<"participant_joined"> = (event) => {
  void event.participant.displayName;
};
const unsubscribe: () => void = engine.on("participant_joined", onJoined);
engine.on("participant_left", (event) => {
  const reason: ParticipantLeftReason = event.reason;
  void reason;
});
engine.on("closed", (event: MeetingEventMap["closed"]) => {
  const reason: CloseReason = event.reason;
  const code: MeetingErrorCode | undefined = event.error?.code;
  void [reason, code];
});
const type: MeetingEventType = "state_changed";
async function flow(): Promise<void> {
  try {
    await engine.join();
    await engine.enableCamera();
    const camera: MediaDeviceOptions = { deviceId: "camera-1" };
    await engine.enableCamera(camera);
    await engine.disableCamera();
    await engine.unmute();
    await engine.unmute({ deviceId: "mic-1" });
    await engine.mute();
    await engine.startScreenShare();
    await engine.stopScreenShare();
    await engine.leave();
  } catch (error) {
    if (error instanceof MeetingError) {
      const retryable: boolean = error.retryable;
      void retryable;
    }
  } finally {
    unsubscribe();
    engine.dispose();
  }
}
void [state, media, local, kind, role, type, flow];
`;

const QUICK_START_SOURCE = `
import assert from "node:assert/strict";
import { FakeRealtime, testUlid } from "./fake-realtime.mjs";
import { createMeetingEngine, MeetingError } from "@strevokit/meeting-sdk";

const realtime = new FakeRealtime();
globalThis.WebSocket = realtime.WebSocket;

const engine = createMeetingEngine({
  token: realtime.tokenFor(testUlid(), "host"),
  realtimeUrl: "wss://realtime.example.com",
});
const states = [];
let closed;
engine.on("state_changed", (event) => states.push(event.state));
engine.on("closed", (event) => (closed = event));

await engine.join();
assert.equal(engine.state, "joined");
assert.equal(engine.self?.role, "host");
await engine.leave();
assert.deepEqual(states, ["connecting", "joining", "joined", "leaving", "closed"]);
assert.equal(closed?.reason, "left");
console.log("quick-start flow join -> joined -> leave -> closed(left) passed against the fake realtime server");

assert.throws(() => createMeetingEngine({ token: "", realtimeUrl: "wss://realtime.example.com" }), MeetingError);

for (const specifier of ["@strevokit/meeting-sdk/dist/index.js", "@strevokit/meeting-sdk/src/index.ts"]) {
  await assert.rejects(import(specifier), (error) => error.code === "ERR_PACKAGE_PATH_NOT_EXPORTED");
}
console.log("deep imports are rejected by the exports map");
`;

const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const output = (error) => `${error.stdout ?? ""}${error.stderr ?? ""}`;

const packed = pack();
const unexpected = packed.files.filter((file) => !ALLOWED_FILES.has(file) && !file.startsWith("docs/"));
const missing = REQUIRED_FILES.filter((file) => !packed.files.includes(file));
if (unexpected.length > 0 || missing.length > 0) {
  fail(`tarball contents wrong. unexpected: [${unexpected.join(", ")}] missing: [${missing.join(", ")}]`);
}

const { dir: extractDir, packageDir } = extract(packed.tarball);
const manifest = readJson(join(packageDir, "package.json"));
rmSync(extractDir, { recursive: true, force: true });
for (const field of DEPENDENCY_FIELDS) {
  if (manifest[field] && Object.keys(manifest[field]).length > 0) {
    fail(`packed package.json declares ${field}; the SDK must have zero runtime dependencies.`);
  }
}

try {
  run("npm", ["publish", "--dry-run", packed.tarball], root);
} catch (error) {
  fail(`npm publish --dry-run failed:\n${output(error)}`);
}
console.log(`npm publish --dry-run succeeded for ${packed.name}@${packed.version}`);
console.log(`dependencies: {}; tarball files: ${packed.files.join(", ")}`);

const consumer = tempDir("meeting-sdk-consumer");
try {
  writeFileSync(join(consumer, "package.json"), JSON.stringify({ name: "consumer", private: true, type: "module" }));
  run("npm", ["install", packed.tarball, "--no-audit", "--no-fund", "--ignore-scripts"], consumer);

  writeFileSync(join(consumer, "consumer.ts"), CONSUMER_SOURCE);
  for (const moduleResolution of ["NodeNext", "Bundler"]) {
    const compilerOptions = {
      strict: true,
      noEmit: true,
      target: "ES2022",
      module: moduleResolution === "NodeNext" ? "NodeNext" : "ESNext",
      moduleResolution,
      lib: ["ES2022", "DOM"],
      types: [],
    };
    writeFileSync(join(consumer, "tsconfig.json"), JSON.stringify({ compilerOptions, files: ["consumer.ts"] }));
    try {
      run(bin("tsc"), ["-p", "tsconfig.json"], consumer);
    } catch (error) {
      fail(`consumer type-check failed (moduleResolution ${moduleResolution}):\n${output(error)}`);
    }
  }
  console.log("consumer type-check passed (NodeNext and Bundler resolution) in a project outside the repo");

  await build({
    absWorkingDir: root,
    entryPoints: ["tests/support/fakeRealtime.ts"],
    outfile: join(consumer, "fake-realtime.mjs"),
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    logLevel: "warning",
  });
  writeFileSync(join(consumer, "quick-start.mjs"), QUICK_START_SOURCE);
  try {
    process.stdout.write(run(process.execPath, ["quick-start.mjs"], consumer));
  } catch (error) {
    fail(`quick-start flow failed:\n${output(error)}`);
  }
} finally {
  rmSync(consumer, { recursive: true, force: true });
}

console.log("pack smoke: ok");
