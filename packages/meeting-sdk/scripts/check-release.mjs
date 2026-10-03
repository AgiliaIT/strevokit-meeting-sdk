// Release guard: the version has a changelog entry, and a public-surface break since the last tag forces a semver bump.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { diffApiReports } from "./apiDiff.mjs";
import { fail, readJson, root } from "./lib.mjs";

const TAG_PREFIX = "meeting-sdk-v";

const git = (args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function parseVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-[\w.]+)?$/.exec(version);
  if (!match) fail(`"${version}" is not a semver version.`);
  return match.slice(1, 4).map(Number);
}

/** The changelog section body for `heading` (e.g. "0.1.0" or "Unreleased"), or null when absent. */
function changelogSection(changelog, heading) {
  const lines = changelog.split("\n");
  const start = lines.findIndex((line) => line.startsWith(`## [${heading}]`));
  if (start === -1) return null;
  const end = lines.findIndex((line, i) => i > start && line.startsWith("## "));
  return lines.slice(start + 1, end === -1 ? undefined : end).join("\n");
}

const { version } = readJson(join(root, "package.json"));
const current = parseVersion(version);
const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");
const tags = git(["tag", "--list", `${TAG_PREFIX}*`, "--sort=-v:refname"]).split("\n").filter(Boolean);
const releasedTag = tags.find((tag) => tag === `${TAG_PREFIX}${version}`);

const section = changelogSection(changelog, version) ?? (releasedTag ? null : changelogSection(changelog, "Unreleased"));
if (section === null) {
  fail(`CHANGELOG.md has no "## [${version}]" section${releasedTag ? "" : ' (or "## [Unreleased]")'}.`);
}
if (!/@strevokit\/signaling-protocol/.test(section)) {
  fail(`CHANGELOG.md section for ${version} must name the bundled @strevokit/signaling-protocol version.`);
}

const previousTag = tags.find((tag) => tag !== releasedTag);
if (!previousTag) {
  console.log(`check:release: ${version} has a changelog entry; no earlier ${TAG_PREFIX}* tag, so no surface diff.`);
  process.exit(0);
}

const reportPath = relative(git(["rev-parse", "--show-toplevel"]), join(root, "etc", "meeting-sdk.api.md"));
let previousReport;
try {
  previousReport = git(["show", `${previousTag}:${reportPath}`]);
} catch {
  fail(`check:release: ${previousTag} has no ${reportPath}; cannot diff the public surface.`);
}
const currentReport = readFileSync(join(root, "etc", "meeting-sdk.api.md"), "utf8");
const { breaking, additive } = diffApiReports(previousReport, currentReport);
for (const change of additive) console.log(`  + ${change}`);

if (breaking.length === 0) {
  console.log(`check:release: ${version} has a changelog entry; public surface is additive since ${previousTag}.`);
  process.exit(0);
}

const previous = parseVersion(previousTag.slice(TAG_PREFIX.length));
const bumped = current[0] >= 1 ? current[0] > previous[0] : current[0] > previous[0] || current[1] > previous[1];
const documented = /^### (?:Breaking|Changed)\b/m.test(section);
if (!bumped || !documented) {
  console.error(`check:release: the public surface changed incompatibly since ${previousTag}:`);
  for (const change of breaking) console.error(`  - ${change}`);
  if (!bumped) console.error(`  ${version} needs a ${current[0] >= 1 ? "major" : "minor"} bump over ${previousTag}.`);
  if (!documented) console.error(`  The ${version} changelog section needs a "### Breaking" or "### Changed" section with migration notes.`);
  process.exit(1);
}
console.log(`check:release: breaking change since ${previousTag} is versioned and documented in ${version}.`);
