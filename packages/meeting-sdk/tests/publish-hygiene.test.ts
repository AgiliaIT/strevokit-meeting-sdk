import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = join(import.meta.dirname, "..", "scripts", "check-publish-hygiene.mjs");
// Built at runtime so this file never contains a token-shaped literal or a private path itself.
const FAKE_TOKEN = `npm_${"A".repeat(30)}`;
const PRIVATE_LINK = ["..", "..", "docs", "ci.md"].join("/");
const LOOPBACK = ["local", "host"].join("");
const LOOPBACK_URL = `ws://${LOOPBACK}:8443`;

interface AllowlistEntry {
  file: string;
  rule: string;
  pattern: string;
  reason: string;
  scope?: string;
}

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Writes `files` under `<temp>/tree` (removed after each test) and returns the temp directory. */
function tree(files: Record<string, string | Buffer>): string {
  const dir = mkdtempSync(join(tmpdir(), "hygiene-tree-"));
  dirs.push(dir);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, "tree", path)), { recursive: true });
    writeFileSync(join(dir, "tree", path), content);
  }
  mkdirSync(join(dir, "tree"), { recursive: true });
  return dir;
}

/** Runs the scanner in tree mode on `<dir>/tree` with `allowlist` and returns its exit status and combined output. */
function scan(dir: string, allowlist: AllowlistEntry[] = []) {
  const allowlistPath = join(dir, "allowlist.json");
  writeFileSync(allowlistPath, JSON.stringify(allowlist));
  const result = spawnSync(process.execPath, [SCRIPT, "--tree", join(dir, "tree"), "--allowlist", allowlistPath], {
    encoding: "utf8",
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

describe("check-publish-hygiene --tree", () => {
  it("passes a clean tree", () => {
    const dir = tree({ "packages/x/src/index.ts": "export const greeting = 'hello';\n" });
    expect(scan(dir)).toMatchObject({ status: 0 });
  });

  it("reports a secret by location and rule without printing it", () => {
    const dir = tree({ "packages/x/tests/a.ts": `const ok = 1;\nconst token = "${FAKE_TOKEN}";\n` });
    const { status, output } = scan(dir);
    expect(status).toBe(1);
    expect(output).toContain("packages/x/tests/a.ts:2 secret/token-prefix");
    expect(output).not.toContain(FAKE_TOKEN);
  });

  it("reports links into private monorepo folders", () => {
    const dir = tree({ "packages/x/README.md": `See [CI](${PRIVATE_LINK}).\n` });
    const { status, output } = scan(dir);
    expect(status).toBe(1);
    expect(output).toContain("packages/x/README.md:1 internal-note/private-path");
  });

  it("reports monorepo app paths", () => {
    const dir = tree({ "packages/x/notes.md": `Handled in ${["apps", "realtime"].join("/")}.\n` });
    expect(scan(dir).output).toContain("packages/x/notes.md:1 internal-note/private-path");
  });

  it("lets a tree entry excuse only its own rule on its own file", () => {
    const dir = tree({
      "packages/x/tests/a.ts": `const url = "${LOOPBACK_URL}";\n`,
      "packages/x/tests/b.ts": `const url = "${LOOPBACK_URL}"; // ${"TO"}DO\n`,
      "packages/x/src/c.ts": `const url = "${LOOPBACK_URL}";\n`,
    });
    const { status, output } = scan(dir, [
      { file: "packages/x/tests/*", rule: "internal-host/loopback", pattern: LOOPBACK, reason: "test", scope: "tree" },
    ]);
    expect(status).toBe(1);
    expect(output).not.toContain("packages/x/tests/a.ts");
    expect(output).toContain("packages/x/tests/b.ts:1 internal-note/marker");
    expect(output).not.toContain("packages/x/tests/b.ts:1 internal-host/loopback");
    expect(output).toContain("packages/x/src/c.ts:1 internal-host/loopback");
  });

  it("fails on a tree entry that matches nothing", () => {
    const dir = tree({ "packages/x/src/index.ts": "export {};\n" });
    const { status, output } = scan(dir, [
      { file: "packages/x/src/index.ts", rule: "internal-host/loopback", pattern: LOOPBACK, reason: "r", scope: "tree" },
    ]);
    expect(status).toBe(1);
    expect(output).toContain("matched nothing; remove it.");
  });

  it("ignores package-scope entries in tree mode", () => {
    const dir = tree({ "packages/x/src/index.ts": "export {};\n" });
    const { status, output } = scan(dir, [
      { file: "dist/index.js*", rule: "internal-host/loopback", pattern: LOOPBACK, reason: "r" },
      { file: "dist/index.d.ts", rule: "internal-host/loopback", pattern: LOOPBACK, reason: "r", scope: "package" },
    ]);
    expect(status).toBe(0);
    expect(output).not.toContain("matched nothing");
  });

  it("skips build output, installed dependencies, and git metadata", () => {
    const secret = `const token = "${FAKE_TOKEN}";\n`;
    const dir = tree({
      "node_modules/dep/index.js": secret,
      "packages/x/dist/index.js": secret,
      "packages/x/build/pack/a.js": secret,
      "packages/y/dist-tests/a.js": secret,
      ".git/config": secret,
      "packages/x/src/index.ts": "export {};\n",
    });
    expect(scan(dir)).toMatchObject({ status: 0 });
  });

  it("fails on files that are not UTF-8 text", () => {
    const dir = tree({ "packages/x/logo.bin": Buffer.from([0xff, 0xfe, 0x00, 0xc3, 0x28]) });
    const { status, output } = scan(dir);
    expect(status).toBe(1);
    expect(output).toContain("packages/x/logo.bin unreadable-binary");
  });

  it("rejects an unknown scope", () => {
    const dir = tree({ "packages/x/src/index.ts": "export {};\n" });
    const { status, output } = scan(dir, [
      { file: "a", rule: "internal-host/loopback", pattern: "x", reason: "r", scope: "everywhere" },
    ]);
    expect(status).toBe(1);
    expect(output).toContain('unknown scope "everywhere"');
  });
});
