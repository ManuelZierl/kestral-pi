import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function packagePaths(document) {
  if (document.integrity?.algorithm !== "sha256") {
    throw new Error("package integrity algorithm must be sha256");
  }
  const assetsObject = document.integrity?.assets;
  if (assetsObject === null || typeof assetsObject !== "object" || Array.isArray(assetsObject)) {
    throw new Error("package integrity assets must be an object");
  }

  const assets = Object.keys(assetsObject);
  if (assets.includes("app.json")) throw new Error("integrity assets must not contain app.json");
  const caseFolded = new Set();
  const paths = new Set(["app.json", ...assets]);
  for (const path of paths) {
    if (
      path.length === 0 ||
      path.includes("\\") ||
      path.includes(":") ||
      path.startsWith("/") ||
      path.split("/").some((part) => part.length === 0 || part === "." || part === "..")
    ) {
      throw new Error(`unsafe package path '${path}'`);
    }
    const folded = path.toLowerCase();
    if (caseFolded.has(folded)) throw new Error(`case-colliding package path '${path}'`);
    caseFolded.add(folded);
  }
  // Rust's BTreeSet orders the UTF-8 path bytes; do not use JavaScript's
  // UTF-16 string ordering for non-ASCII package paths.
  return [...paths].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
}

async function regularFile(packageDirectory, path) {
  const parts = path.split("/");
  let filePath = packageDirectory;
  for (let index = 0; index < parts.length; index += 1) {
    filePath = join(filePath, parts[index]);
    const metadata = await lstat(filePath).catch((error) => {
      throw new Error(`read package file '${path}' failed: ${error.message}`);
    });
    // lstat only on the leaf would still follow symlinked parent directories.
    if (index < parts.length - 1) {
      if (!metadata.isDirectory()) throw new Error(`package path '${path}' contains an entry that is not a directory`);
    } else if (!metadata.isFile()) {
      throw new Error(`package entry '${path}' is not a regular file`);
    }
  }
  return readFile(filePath);
}

async function validateSourceTree(packageDirectory, declaredPaths) {
  const actual = new Set();

  async function walk(directory, prefix = "") {
    const entries = await readdir(directory, { withFileTypes: true }).catch((error) => {
      throw new Error(`read package directory failed: ${error.message}`);
    });
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`package symlinks are unsupported: ${relative}`);
      if (entry.isDirectory()) {
        await walk(path, relative);
      } else if (entry.isFile()) {
        actual.add(relative);
      } else {
        throw new Error(`unsupported package file type: ${relative}`);
      }
    }
  }

  await walk(packageDirectory);
  actual.delete("app.signature.json");
  const declared = new Set(declaredPaths);
  const extra = [...actual].filter((path) => !declared.has(path)).sort();
  const missing = [...declared].filter((path) => !actual.has(path)).sort();
  if (extra.length > 0 || missing.length > 0) {
    throw new Error(`package file declaration mismatch; extra=${JSON.stringify(extra)}, missing=${JSON.stringify(missing)}`);
  }
}

/**
 * Match host/src-tauri/src/package.rs::package_digest exactly.
 */
export async function packageDigest(packageDirectory) {
  const root = resolve(packageDirectory);
  const appBytes = await regularFile(root, "app.json");
  let document;
  try {
    document = JSON.parse(appBytes.toString("utf8"));
  } catch (error) {
    throw new Error(`invalid app.json: ${error.message}`);
  }

  const paths = packagePaths(document);
  await validateSourceTree(root, paths);
  const hasher = createHash("sha256");
  for (const path of paths) {
    const bytes = path === "app.json" ? appBytes : await regularFile(root, path);
    const pathBytes = Buffer.from(path, "utf8");
    const pathLength = Buffer.alloc(8);
    const byteLength = Buffer.alloc(8);
    pathLength.writeBigUInt64LE(BigInt(pathBytes.length));
    byteLength.writeBigUInt64LE(BigInt(bytes.length));
    hasher.update(pathLength);
    hasher.update(pathBytes);
    hasher.update(byteLength);
    hasher.update(bytes);
  }
  return `sha256-${hasher.digest("hex")}`;
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === currentFile) {
  if (process.argv.length > 3) throw new Error("usage: node scripts/package-digest.mjs [package-directory]");
  const projectRoot = resolve(dirname(currentFile), "..");
  const packageDirectory = process.argv[2] ? resolve(projectRoot, process.argv[2]) : join(projectRoot, "dist");
  console.log(await packageDigest(packageDirectory));
}
