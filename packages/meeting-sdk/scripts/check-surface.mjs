// Public surface guard: no `any` in the shipped types, no media-topology vocabulary in types or docs, and no
// protocol types leaking through the declarations.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fail, requireBuild, root } from "./lib.mjs";

const TOPOLOGY_TERMS = ["p2p", "peer-to-peer", "sfu", "mediasoup", "turn", "ice", "sdp", "router", "transport", "producer", "consumer", "webrtc"];

/** Reviewed exceptions: `{ file, term, reason }`. */
const ALLOWED_TERMS = [];

const termPattern = new RegExp(`(?<![\\w-])(${TOPOLOGY_TERMS.map((t) => t.replace(/-/g, "\\-")).join("|")})(?![\\w-])`, "gi");

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

function protocolExportNames() {
  const declarations = readFileSync(join(root, "node_modules", "@strevokit", "signaling-protocol", "dist", "index.d.ts"), "utf8");
  const names = new Set();
  for (const [, list] of declarations.matchAll(/export (?:type )?\{([^}]*)\}/g)) {
    for (const item of list.split(",")) {
      const name = item.trim().split(/\s+as\s+/).pop()?.replace(/^type\s+/, "");
      if (name) names.add(name);
    }
  }
  for (const [, name] of declarations.matchAll(/export (?:declare )?(?:const|function|class|type|interface) (\w+)/g)) {
    names.add(name);
  }
  if (names.size === 0) fail("check:surface could not read the protocol's exported names.");
  return names;
}

requireBuild();
const declarations = readFileSync(join(root, "dist", "index.d.ts"), "utf8");
const code = stripComments(declarations);
const problems = [];

const anyCount = [...code.matchAll(/(?<![\w$."'])any(?![\w$"'])/g)].length;
if (anyCount > 0) problems.push(`dist/index.d.ts uses \`any\` ${anyCount} time(s)`);

const scanned = ["dist/index.d.ts", "README.md", ...walk(join(root, "docs")).map((path) => relative(root, path))];
let termCount = 0;
for (const file of scanned) {
  readFileSync(join(root, file), "utf8")
    .split("\n")
    .forEach((line, i) => {
      for (const [, term] of line.matchAll(termPattern)) {
        if (ALLOWED_TERMS.some((entry) => entry.file === file && entry.term === term.toLowerCase())) continue;
        termCount += 1;
        problems.push(`${file}:${i + 1} topology term "${term.toLowerCase()}"`);
      }
    });
}

for (const name of protocolExportNames()) {
  if (new RegExp(`(?<![\\w$])${name}(?![\\w$])`).test(code)) {
    problems.push(`dist/index.d.ts references protocol identifier ${name}`);
  }
}

if (problems.length > 0) {
  for (const problem of problems) console.error(problem);
  process.exit(1);
}
console.log(`check:surface: ${termCount} topology terms, ${anyCount} any`);
