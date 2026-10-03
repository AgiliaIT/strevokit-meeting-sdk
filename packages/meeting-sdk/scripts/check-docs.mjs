// Every public export, event type, and error code must be documented in docs/api-reference.md.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fail, root } from "./lib.mjs";

const report = readFileSync(join(root, "etc", "meeting-sdk.api.md"), "utf8");
const reference = readFileSync(join(root, "docs", "api-reference.md"), "utf8");

const exports = [...report.matchAll(/^export (?:declare )?(?:function|class|interface|type|const) (\w+)/gm)].map((m) => m[1]);

const eventMap = /export interface MeetingEventMap \{([\s\S]*?)\n\}/.exec(report)?.[1] ?? "";
const events = [...eventMap.matchAll(/^ {4}(\w+): \{/gm)].map((m) => m[1]);

const codeUnion = /export type MeetingErrorCode = ([^;]+);/.exec(report)?.[1] ?? "";
const codes = [...codeUnion.matchAll(/"(\w+)"/g)].map((m) => m[1]);

if (exports.length === 0 || events.length === 0 || codes.length === 0) {
  fail("check:docs could not read exports, events, or error codes from etc/meeting-sdk.api.md.");
}

const documented = (name) => new RegExp(`\`${name}[\`(<]`).test(reference);
const missing = [
  ...exports.filter((name) => !documented(name)).map((name) => `export ${name}`),
  ...events.filter((name) => !documented(name)).map((name) => `event ${name}`),
  ...codes.filter((name) => !documented(name)).map((name) => `error code ${name}`),
];

if (missing.length > 0) {
  console.error("docs/api-reference.md is missing:");
  for (const item of missing) console.error(`  ${item}`);
  process.exit(1);
}
console.log(`check:docs: ${exports.length} exports, ${events.length} events, ${codes.length} error codes documented`);
