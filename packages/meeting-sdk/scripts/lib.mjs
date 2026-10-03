// Shared helpers for the packaging checks: everything runs against the packed tarball, not the working tree.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const root = join(dirname(fileURLToPath(import.meta.url)), "..");
export const bin = (name) => join(root, "node_modules", ".bin", name);

export function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function requireBuild() {
  for (const file of ["dist/index.js", "dist/index.js.map", "dist/index.d.ts"]) {
    if (!existsSync(join(root, file))) {
      fail(`${file} is missing; run \`npm run build\` first.`);
    }
  }
}

export function pack() {
  requireBuild();
  const destination = join(root, "build", "pack");
  mkdirSync(destination, { recursive: true });
  const stdout = execFileSync("npm", ["pack", "--json", "--pack-destination", destination], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  const [info] = JSON.parse(stdout);
  return {
    tarball: join(destination, info.filename),
    files: info.files.map((file) => file.path).sort(),
    name: info.name,
    version: info.version,
  };
}

export function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), `${prefix}-`));
}

export function extract(tarball) {
  const dir = tempDir("meeting-sdk-pack");
  execFileSync("tar", ["-xzf", tarball, "-C", dir]);
  return { dir, packageDir: join(dir, "package") };
}

export function fail(message) {
  console.error(message);
  process.exit(1);
}
