import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const licenseFilePattern = /^(licen[cs]e|copying|notice|copyright)/i;

const compareText = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const normalize = (value) => value.replace(/\r\n/g, "\n").trim();

function repositoryUrl(repository) {
  if (typeof repository === "string") return repository;
  return repository?.url ?? "not declared";
}

function licenseFiles(packageDirectory, declaredLicenseFile) {
  const candidates = new Set();
  if (declaredLicenseFile) candidates.add(resolve(packageDirectory, declaredLicenseFile));
  for (const name of readdirSync(packageDirectory)) {
    const path = join(packageDirectory, name);
    if (licenseFilePattern.test(name) && statSync(path).isFile()) candidates.add(path);
  }
  return [...candidates]
    .filter(existsSync)
    .sort(compareText)
    .map((path) => ({ name: relative(packageDirectory, path).replaceAll("\\", "/"), text: normalize(readFileSync(path, "utf8")) }))
    .filter(({ text }) => text.length > 0);
}

export function createThirdPartyNotices(projectRoot) {
  const lock = JSON.parse(readFileSync(join(projectRoot, "package-lock.json"), "utf8"));
  const packagesById = new Map();
  for (const [packagePath, lockEntry] of Object.entries(lock.packages)) {
    if (!packagePath.includes("node_modules/") || lockEntry.link || lockEntry.dev === true) continue;
    const packageDirectory = join(projectRoot, packagePath);
    if (!existsSync(packageDirectory)) continue;
    const manifest = JSON.parse(readFileSync(join(packageDirectory, "package.json"), "utf8"));
    const license = typeof manifest.license === "string" ? manifest.license : lockEntry.license;
    if (!license) throw new Error(`Missing npm license metadata: ${manifest.name}@${manifest.version}`);
    const dependency = {
      name: manifest.name,
      version: manifest.version,
      license,
      source: repositoryUrl(manifest.repository),
      files: licenseFiles(packageDirectory, manifest.licenseFile),
    };
    const id = `${dependency.name}@${dependency.version}`;
    const existing = packagesById.get(id);
    if (!existing || dependency.files.length > existing.files.length) packagesById.set(id, dependency);
  }

  const dependencies = [...packagesById.values()].sort((left, right) => compareText(`${left.name}@${left.version}`, `${right.name}@${right.version}`));
  const textsByHash = new Map();
  for (const dependency of dependencies) {
    for (const file of dependency.files) {
      const hash = createHash("sha256").update(file.text).digest("hex");
      const entry = textsByHash.get(hash) ?? { text: file.text, packages: [] };
      entry.packages.push(`${dependency.name}@${dependency.version} (${file.name})`);
      textsByHash.set(hash, entry);
    }
  }

  const lines = [
    "KESTRAL PI THIRD-PARTY NOTICES",
    "===============================",
    "",
    "Generated from the installed production dependency tree. Package license",
    "metadata is listed for every dependency; distributed license and notice files",
    "are reproduced below. This file is informational and does not replace the",
    "licenses that govern the corresponding software.",
    "",
    "DEPENDENCY INVENTORY",
    "--------------------",
  ];
  for (const dependency of dependencies) {
    lines.push(
      "",
      `${dependency.name}@${dependency.version}`,
      `License: ${dependency.license}`,
      `Source metadata: ${dependency.source}`,
      `Bundled license files: ${dependency.files.map(({ name }) => name).join(", ") || "none distributed in package"}`,
    );
  }
  lines.push("", "LICENSE AND NOTICE TEXTS", "------------------------");
  for (const [hash, entry] of [...textsByHash.entries()].sort(([left], [right]) => compareText(left, right))) {
    lines.push("", `SHA-256: ${hash}`, "Used by:");
    for (const packageName of entry.packages.sort(compareText)) lines.push(`- ${packageName}`);
    lines.push("", entry.text);
  }
  return `${lines.join("\n")}\n`;
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === currentFile) {
  const projectRoot = resolve(dirname(currentFile), "..");
  const output = resolve(projectRoot, process.argv[2] ?? "THIRD-PARTY-NOTICES.txt");
  const notices = createThirdPartyNotices(projectRoot);
  await writeFile(output, notices, "utf8");
  const packagedOutput = resolve(projectRoot, "dist/backend/THIRD-PARTY-NOTICES.txt");
  if (output === resolve(projectRoot, "THIRD-PARTY-NOTICES.txt") && existsSync(packagedOutput)) {
    await writeFile(packagedOutput, notices, "utf8");
  }
}
