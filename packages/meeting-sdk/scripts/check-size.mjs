// Bundle-size budget for the core SDK: minified + gzip (level 9) size of dist/index.js.
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { constants, gzipSync } from "node:zlib";
import { transform } from "esbuild";
import { readJson, requireBuild, root } from "./lib.mjs";

function commit() {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "unknown";
  }
}

requireBuild();
const source = readFileSync(join(root, "dist", "index.js"), "utf8");
const { code } = await transform(source, { minify: true, format: "esm", target: "es2022", legalComments: "none" });
const report = {
  rawBytes: Buffer.byteLength(source),
  minifiedBytes: Buffer.byteLength(code),
  gzipBytes: gzipSync(code, { level: constants.Z_BEST_COMPRESSION }).length,
  budgetBytes: readJson(join(root, "size-budget.json")).maxGzipBytes,
  commit: commit(),
};
writeFileSync(join(root, "dist", "size-report.json"), `${JSON.stringify(report, null, 2)}\n`);

const line = `meeting-sdk core: ${report.gzipBytes} B gzipped / budget ${report.budgetBytes} B`;
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    `**meeting-sdk size**: ${report.gzipBytes} B gzipped (${report.minifiedBytes} B minified, ${report.rawBytes} B raw) / budget ${report.budgetBytes} B\n`,
  );
}
if (report.gzipBytes > report.budgetBytes) {
  console.error(`${line} (over budget)`);
  process.exit(1);
}
console.log(line);
