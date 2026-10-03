import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import { gzipSync } from "node:zlib";

const DIST = new URL("../../dist/", import.meta.url);
const MAX_GZIP_BYTES = 8 * 1024;

test("runtime entry (excluding conformance) gzips under 8 KB", () => {
  const files = readdirSync(DIST).filter((name) => name.endsWith(".js"));
  assert.ok(files.includes("index.js"), "dist/index.js missing — run the build first");
  const source = files.map((name) => readFileSync(new URL(name, DIST), "utf8")).join("\n");
  const gzipped = gzipSync(source, { level: 9 }).byteLength;
  console.log(`runtime bundle: ${files.length} files, ${gzipped} bytes gzipped`);
  assert.ok(gzipped < MAX_GZIP_BYTES, `runtime bundle is ${gzipped} bytes gzipped`);
});

test("the runtime entry never imports the conformance module", () => {
  for (const name of readdirSync(DIST).filter((file) => file.endsWith(".js"))) {
    const source = readFileSync(new URL(name, DIST), "utf8");
    assert.doesNotMatch(source, /from\s+["']\.\/conformance/, name);
    assert.doesNotMatch(source, /import\(\s*["']\.\/conformance/, name);
  }
});
