// Builds the single-file ESM bundle (signaling protocol inlined) and the rolled-up type declarations.
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bin = (name) => join(root, "node_modules", ".bin", name);
const run = (cmd, args) => execFileSync(cmd, args, { cwd: root, stdio: "inherit" });

rmSync(join(root, "dist"), { recursive: true, force: true });
rmSync(join(root, "build"), { recursive: true, force: true });

run(bin("tsc"), ["-p", "tsconfig.json"]);

const result = await build({
  absWorkingDir: root,
  entryPoints: ["src/index.ts"],
  outfile: "dist/index.js",
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  sourcemap: true,
  sourcesContent: true,
  minify: false,
  metafile: true,
  legalComments: "none",
  logLevel: "warning",
});
mkdirSync(join(root, "build"), { recursive: true });
writeFileSync(join(root, "build", "meta.json"), JSON.stringify(result.metafile, null, 2));

mkdirSync(join(root, "etc"), { recursive: true });
// The build fails when the public API differs from etc/meeting-sdk.api.md; `npm run api:update` accepts the change.
const local = process.argv.includes("--update-api") ? ["--local"] : [];
try {
  run(bin("api-extractor"), ["run", ...local]);
} catch {
  console.error("The public API changed. Review it, then run `npm run api:update` to accept the new etc/meeting-sdk.api.md.");
  process.exit(1);
}

const bundle = readFileSync(join(root, "dist", "index.js"), "utf8");
const bareImport = /^\s*(?:import|export)\s[^;]*?\sfrom\s*["'][^./][^"']*["']/m;
if (bareImport.test(bundle) || /\bimport\s*\(\s*["'][^./]/.test(bundle)) {
  console.error("dist/index.js still imports a package; every dependency must be bundled.");
  process.exit(1);
}
console.log("meeting-sdk build: dist/index.js, dist/index.js.map, dist/index.d.ts");
