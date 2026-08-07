import { execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { promisify } from "node:util";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, "..");

async function filesUnder(directory) {
  const result = new Map();
  async function visit(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) result.set(relative(projectRoot, path), await readFile(path));
      else throw new Error(`reproducibility output contains non-regular entry '${relative(projectRoot, path)}'`);
    }
  }
  await visit(directory);
  return result;
}

async function snapshot() {
  const files = await filesUnder(join(projectRoot, "dist"));
  files.set("THIRD-PARTY-NOTICES.txt", await readFile(join(projectRoot, "THIRD-PARTY-NOTICES.txt")));
  return files;
}

async function build() {
  await execFileAsync(process.execPath, ["build.mjs"], { cwd: projectRoot });
}

await build();
const first = await snapshot();
await build();
const second = await snapshot();
const paths = new Set([...first.keys(), ...second.keys()]);
for (const path of [...paths].sort()) {
  const left = first.get(path);
  const right = second.get(path);
  if (!left || !right || !left.equals(right)) throw new Error(`non-reproducible build output: ${path}`);
}
console.log(`Two builds produced identical output for ${paths.size} files.`);
