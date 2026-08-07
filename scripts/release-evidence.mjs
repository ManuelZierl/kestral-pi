import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { packageDigest } from "./package-digest.mjs";

export const LIFECYCLE_CHECKS = [
  "package_inspection",
  "permission_denial",
  "activation",
  "representative_action",
  "restart",
  "update_data_preservation",
  "disable_enable",
  "keep_data_uninstall",
  "purge_data_uninstall",
];

export const EXPECTED_BACKEND = {
  kind: "agent-worker",
  authority_mode: "unsandboxed",
  protocol_version: 1,
  entry: "backend/worker.mjs",
};

const EXPECTED_CAPABILITY = "agent.run";
const EXPECTED_ARTIFACT = "agent-transcript";
const COMMIT = /^[0-9a-f]{40}$/;
const SHA256 = /^sha256-[0-9a-f]{64}$/;
const REPOSITORY = /^https:\/\/github\.com\/[^/]+\/[^/]+$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function object(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

export function exactKeys(value, expected, label) {
  const actual = Object.keys(object(value, label)).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error(`${label} fields differ: expected ${wanted.join(", ")}; found ${actual.join(", ")}`);
  }
}

function nonEmpty(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
}

function commit(value, label) {
  if (typeof value !== "string" || !COMMIT.test(value)) {
    throw new Error(`${label} must be a lowercase full Git commit`);
  }
}

function validateDate(value, label) {
  if (typeof value !== "string" || !ISO_DATE.test(value) || Number.isNaN(Date.parse(value))) {
    throw new Error(`${label} must be an ISO date-time`);
  }
}

function validateLifecycle(lifecycle) {
  exactKeys(lifecycle, LIFECYCLE_CHECKS, "observations.lifecycle");
  for (const check of LIFECYCLE_CHECKS) {
    const result = lifecycle[check];
    exactKeys(result, ["status", "observation"], `observations.lifecycle.${check}`);
    if (result.status !== "passed") {
      throw new Error(`observations.lifecycle.${check}.status must be 'passed'`);
    }
    nonEmpty(result.observation, `observations.lifecycle.${check}.observation`);
  }
}

export function validateObservations(value) {
  exactKeys(value, ["tested_at", "platforms", "lifecycle"], "observations");
  validateDate(value.tested_at, "observations.tested_at");
  if (!Array.isArray(value.platforms) || value.platforms.length === 0) {
    throw new Error("observations.platforms must contain at least one platform");
  }
  if (value.platforms.some((platform) => typeof platform !== "string" || platform.length === 0)) {
    throw new Error("observations.platforms must contain non-empty strings");
  }
  if (new Set(value.platforms).size !== value.platforms.length) {
    throw new Error("observations.platforms must not contain duplicates");
  }
  validateLifecycle(value.lifecycle);
  return value;
}

export function workflowUrl(env) {
  const server = env.GITHUB_SERVER_URL;
  const repository = env.GITHUB_REPOSITORY;
  const runId = env.GITHUB_RUN_ID;
  if (server !== "https://github.com") throw new Error("GITHUB_SERVER_URL must be https://github.com");
  if (typeof repository !== "string" || !/^[^/]+\/[^/]+$/.test(repository)) {
    throw new Error("GITHUB_REPOSITORY must be owner/repository");
  }
  if (typeof runId !== "string" || !/^\d+$/.test(runId)) {
    throw new Error("GITHUB_RUN_ID must be a numeric workflow run ID");
  }
  return `${server}/${repository}/actions/runs/${runId}`;
}

function gitCommands(root) {
  return (args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function validatePackageContract(manifest) {
  if (manifest.backend?.kind !== EXPECTED_BACKEND.kind) {
    throw new Error("dist/app.json must declare an agent-worker backend");
  }
  exactKeys(manifest.backend, Object.keys(EXPECTED_BACKEND), "dist.app.json backend");
  for (const [key, expected] of Object.entries(EXPECTED_BACKEND)) {
    if (manifest.backend[key] !== expected) {
      throw new Error(`dist/app.json backend.${key} must be ${JSON.stringify(expected)}`);
    }
  }
  if (JSON.stringify(manifest.data) !== JSON.stringify({ kind: "none" })) {
    throw new Error("dist/app.json data must be { kind: 'none' }");
  }

  const capabilities = manifest.manifest?.capabilities;
  if (!Array.isArray(capabilities) || capabilities.length !== 1 || capabilities[0]?.name !== EXPECTED_CAPABILITY) {
    throw new Error("dist/app.json agent-worker must declare exactly the agent.run capability");
  }
  const artifactTypes = manifest.manifest?.artifact_types;
  if (!Array.isArray(artifactTypes) || artifactTypes.length !== 1 || artifactTypes[0]?.name !== EXPECTED_ARTIFACT) {
    throw new Error("dist/app.json agent-worker must declare exactly the agent-transcript artifact type");
  }
}

export async function createEvidence({
  root,
  observations,
  expectedPackageDigest,
  expectedAppId,
  expectedRepository,
  hostVersion,
  hostCommit,
  env = process.env,
  git = gitCommands(root),
}) {
  validateObservations(observations);
  nonEmpty(hostVersion, "host version");
  nonEmpty(expectedAppId, "expected app ID");
  if (typeof expectedRepository !== "string" || !REPOSITORY.test(expectedRepository)) {
    throw new Error("expected repository must be a canonical GitHub HTTPS repository");
  }
  commit(hostCommit, "host commit");
  if (typeof expectedPackageDigest !== "string" || !SHA256.test(expectedPackageDigest)) {
    throw new Error("expected package digest must be a sha256 digest");
  }

  const head = git(["rev-parse", "HEAD"]);
  commit(head, "source HEAD");
  if (env.GITHUB_SHA !== head) {
    throw new Error(`GITHUB_SHA ${env.GITHUB_SHA || "<missing>"} does not match source HEAD ${head}`);
  }
  if (git(["status", "--porcelain", "--untracked-files=all"]) !== "") {
    throw new Error("source checkout is not clean");
  }

  const repository = `https://github.com/${env.GITHUB_REPOSITORY || ""}`;
  if (!REPOSITORY.test(repository)) throw new Error("source repository is not a canonical GitHub HTTPS repository");
  if (repository !== expectedRepository) throw new Error("source repository does not match expected repository");

  const packageRoot = join(root, "dist");
  const [packageManifest, packageMetadata] = await Promise.all([
    readFile(join(packageRoot, "app.json"), "utf8").then(JSON.parse),
    readFile(join(root, "package.json"), "utf8").then(JSON.parse),
  ]);
  if (packageManifest.id !== expectedAppId) throw new Error("dist/app.json app identity does not match expected app ID");
  if (packageManifest.version !== packageMetadata.version) throw new Error("dist/app.json version does not match package.json");
  validatePackageContract(packageManifest);

  const actualDigest = await packageDigest(packageRoot);
  if (actualDigest !== expectedPackageDigest) {
    throw new Error(`package digest mismatch: expected ${expectedPackageDigest}, got ${actualDigest}`);
  }

  return {
    format_version: 1,
    app: { id: packageManifest.id, version: packageManifest.version },
    source: { repository, commit: head, clean: true },
    package: { digest: actualDigest },
    host: { version: hostVersion, commit: hostCommit },
    run: { workflow_url: workflowUrl(env), tested_at: observations.tested_at, platforms: observations.platforms },
    extension_contributions: [],
    lifecycle: observations.lifecycle,
  };
}

function optionValue(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

async function readObservations(args) {
  const file = optionValue(args, "--observations-file") || optionValue(args, "--observations");
  const envName = optionValue(args, "--observations-env");
  const inline = optionValue(args, "--observations-json") || (envName && process.env[envName]);
  if (!file && !inline) throw new Error("required manual observations are missing");
  if (file && inline) throw new Error("provide one observations file or observations JSON value");
  const raw = file ? await readFile(resolve(file), "utf8") : inline;
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`manual observations are not valid JSON: ${error.message}`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const observations = await readObservations(args);
  const root = resolve(optionValue(args, "--source") || dirname(dirname(fileURLToPath(import.meta.url))));
  const expectedPackageDigest = optionValue(args, "--expected-package-digest") || process.env.EXPECTED_PACKAGE_DIGEST;
  const expectedAppId = optionValue(args, "--expected-app-id") || process.env.EXPECTED_APP_ID;
  const expectedRepository = optionValue(args, "--expected-repository") || process.env.EXPECTED_REPOSITORY;
  const hostVersion = optionValue(args, "--host-version") || process.env.HOST_VERSION;
  const hostCommit = optionValue(args, "--host-commit") || process.env.HOST_COMMIT;
  const output = optionValue(args, "--output") || process.env.RELEASE_EVIDENCE_OUTPUT;
  if (!expectedPackageDigest || !expectedAppId || !expectedRepository || !hostVersion || !hostCommit || !output) {
    throw new Error("expected app ID, repository, package digest, host version, host commit, and output are required");
  }
  const evidence = await createEvidence({ root, observations, expectedPackageDigest, expectedAppId, expectedRepository, hostVersion, hostCommit });
  await writeFile(resolve(output), `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx" });
  console.log(`wrote ${resolve(output)}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
