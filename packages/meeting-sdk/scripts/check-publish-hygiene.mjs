// Scans public files for secrets, internal hosts, and internal notes. Two modes:
//   default:          everything npm would publish, including the source map's embedded sources;
//   --tree <dir>:     every file in a repository tree (the public source mirror), minus build output and git metadata.
// Allowlist entries apply to one mode through "scope" ("package", the default, or "tree"); use --allowlist <path> to
// read a different allowlist file. Findings report the location and rule only: printing the match would leak a
// secret into CI logs.
import { readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { extract, fail, pack, readJson, root } from "./lib.mjs";

const URL_PREFIX = String.raw`\b(?:wss?|https?):\/\/`;

const RULES = [
  { id: "secret", name: "jwt", pattern: /eyJ[\w-]{6,}\.eyJ[\w-]{6,}\.[\w-]*/ },
  { id: "secret", name: "private-key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  {
    id: "secret",
    name: "token-prefix",
    pattern: /\b(?:npm_[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,}|sk_(?:live|test)_[A-Za-z0-9]{10,}|AKIA[0-9A-Z]{16})\b/,
  },
  { id: "secret", name: "bearer", pattern: /\bBearer\s+[\w.~+/-]{16,}/ },
  {
    id: "secret",
    name: "credential-assignment",
    pattern: /\b\w*(?:secret|password|api_?key|token)\w*["']?\s*[:=]\s*["'`][^"'`\s]{17,}["'`]/i,
  },
  {
    id: "internal-host",
    name: "private-ipv4",
    pattern: /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})\b/,
  },
  { id: "internal-host", name: "internal-tld", pattern: /\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:internal|local|lan|corp)\b(?![.\w-])/i },
  {
    id: "internal-host",
    name: "compose-host",
    pattern: new RegExp(`${URL_PREFIX}(?:api|realtime|postgres|redis|otel-collector|web)(?![\\w.-])`, "i"),
  },
  { id: "internal-host", name: "loopback", pattern: /\b(?:localhost|127\.0\.0\.1)\b/ },
  { id: "internal-host", name: "dev-port", pattern: /(?<![\w.])1300[01](?!\d)/ },
  { id: "internal-host", name: "strevokit-host", pattern: new RegExp(`${URL_PREFIX}[^\\s/"'\`]*strevokit`, "i") },
  { id: "internal-host", name: "environment-url", pattern: new RegExp(`${URL_PREFIX}[^\\s"'\`]*\\b(?:staging|prod)\\b`, "i") },
  { id: "internal-note", name: "marker", pattern: /\b(?:TODO|FIXME|HACK|XXX)\b|@internal-note/ },
  { id: "internal-note", name: "spec-path", pattern: /\bspecs\/0\d/ },
  { id: "internal-note", name: "card-id", pattern: /\bPH\d-\d+/ },
  {
    id: "internal-note",
    name: "private-path",
    pattern: /(?:\.\.\/){2,}(?:docs|specs|apps|scripts|\.github)\b|\bapps\/(?:api|realtime|web)\b/,
  },
  { id: "internal-note", name: "profanity", pattern: /\b(?:fuck\w*|shit\w*|crap\w*|wtf|damn\w*|bullshit)\b/i },
];

/** The `<id>/<name>` key used in findings and allowlist entries. */
const ruleKey = (rule) => `${rule.id}/${rule.name}`;
const RULE_KEYS = new Set(RULES.map(ruleKey));
const SCOPES = new Set(["package", "tree"]);
const TREE_SKIP = new Set([".git", "node_modules", "dist", "build", "dist-tests"]);

/**
 * Each entry excuses one rule, and only for the text its pattern matches: that text is removed before the rule
 * runs, and every other rule still scans the whole line. Only entries for the current scope are returned.
 */
function loadAllowlist(path, scope) {
  const name = relative(process.cwd(), path) || path;
  const entries = readJson(path);
  if (!Array.isArray(entries)) fail(`${name} must be an array.`);
  return entries
    .map((entry, index) => {
      const fields = ["file", "rule", "pattern", "reason"];
      if (fields.some((field) => typeof entry[field] !== "string" || entry[field].trim() === "")) {
        fail(`${name} entry ${index} needs non-empty "file", "rule", "pattern", and "reason".`);
      }
      if (!RULE_KEYS.has(entry.rule)) {
        fail(`${name} entry ${index} names unknown rule "${entry.rule}".`);
      }
      const entryScope = entry.scope ?? "package";
      if (!SCOPES.has(entryScope)) {
        fail(`${name} entry ${index} has unknown scope "${entryScope}" (use "package" or "tree").`);
      }
      return {
        ...entry,
        scope: entryScope,
        index,
        fileMatcher: new RegExp(`^${entry.file.split("*").map(escapeRegExp).join(".*")}$`),
        lineMatcher: new RegExp(entry.pattern),
        spanMatcher: new RegExp(entry.pattern, "g"),
        used: false,
      };
    })
    .filter((entry) => entry.scope === scope);
}

/** Escapes `text` so it matches literally inside a regular expression. */
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Every file path under `dir`, skipping directories and files whose name is in `skip`. */
function walk(dir, skip = new Set()) {
  return readdirSync(dir).flatMap((name) => {
    if (skip.has(name)) return [];
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path, skip) : [path];
  });
}

/** Every file in a repository tree; files that are not UTF-8 text become findings instead of units. */
function collectTreeUnits(treeDir) {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const units = [];
  const unreadable = [];
  const paths = walk(treeDir, TREE_SKIP);
  for (const path of paths) {
    const label = relative(treeDir, path).split("\\").join("/");
    try {
      units.push({ label, text: decoder.decode(readFileSync(path)) });
    } catch {
      unreadable.push(`${label} unreadable-binary`);
    }
  }
  return { units, unreadable, files: paths.length };
}

/** Every text unit to scan: published files, plus each embedded source of the source map. */
function collectUnits(packageDir) {
  const units = [];
  let mapSources = 0;
  for (const path of walk(packageDir)) {
    const file = relative(packageDir, path);
    const text = readFileSync(path, "utf8");
    if (file.endsWith(".map")) {
      const map = JSON.parse(text);
      units.push({ label: `${file}#sources`, text: (map.sources ?? []).join("\n") });
      units.push({ label: `${file}#names`, text: (map.names ?? []).join("\n") });
      (map.sourcesContent ?? []).forEach((content, i) => {
        mapSources += 1;
        units.push({ label: `${file}#${map.sources?.[i] ?? i}`, text: content ?? "" });
      });
    } else {
      units.push({ label: file, text });
    }
  }
  return { units, files: walk(packageDir).length, mapSources };
}

/** Runs every rule on every line and returns `<label>:<line> <rule>` findings; marks the allowlist entries it used. */
function scan(units, allowlist) {
  const findings = [];
  for (const { label, text } of units) {
    const fileEntries = allowlist.filter((entry) => entry.fileMatcher.test(label));
    text.split("\n").forEach((line, i) => {
      for (const rule of RULES) {
        if (!rule.pattern.test(line)) continue;
        const excusing = fileEntries.filter((entry) => entry.rule === ruleKey(rule) && entry.lineMatcher.test(line));
        let residue = line;
        for (const entry of excusing) {
          entry.used = true;
          residue = residue.replace(entry.spanMatcher, "");
        }
        if (excusing.length === 0 || rule.pattern.test(residue)) {
          findings.push(`${label}:${i + 1} ${ruleKey(rule)}`);
        }
      }
    });
  }
  return findings;
}

/** Prints the summary, findings, and unused allowlist entries (never the matched text); any of them fails the run. */
function report(summary, findings, allowlist) {
  const unused = allowlist.filter((entry) => !entry.used);
  console.log(`${summary}, ${findings.length} findings`);
  for (const finding of findings) console.error(`  ${finding}`);
  for (const entry of unused) {
    console.error(`  allow-list entry ${entry.index} (${entry.file}) matched nothing; remove it.`);
  }
  if (findings.length > 0 || unused.length > 0) process.exitCode = 1;
}

const { values: args } = parseArgs({ options: { tree: { type: "string" }, allowlist: { type: "string" } } });
const allowlistPath = resolve(args.allowlist ?? join(root, "publish-hygiene-allowlist.json"));

if (args.tree !== undefined) {
  const treeDir = resolve(args.tree);
  const allowlist = loadAllowlist(allowlistPath, "tree");
  const { units, unreadable, files } = collectTreeUnits(treeDir);
  report(`publish hygiene (tree): ${files} files scanned`, [...unreadable, ...scan(units, allowlist)], allowlist);
} else {
  const allowlist = loadAllowlist(allowlistPath, "package");
  const { tarball } = pack();
  const { dir, packageDir } = extract(tarball);
  try {
    const { units, files, mapSources } = collectUnits(packageDir);
    report(`publish hygiene: ${files} files scanned (incl. ${mapSources} source-map sources)`, scan(units, allowlist), allowlist);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
