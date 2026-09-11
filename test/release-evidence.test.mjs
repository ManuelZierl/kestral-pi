import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { packageDigest } from "../scripts/package-digest.mjs";
import {
  EXPECTED_BACKEND,
  LIFECYCLE_CHECKS,
  createEvidence,
  validateObservations,
  workflowUrl,
} from "../scripts/release-evidence.mjs";

const HEAD = "0123456789abcdef0123456789abcdef01234567";
const APP_ID = "com.ma-zierl.kestral-pi";
const REPOSITORY = "https://github.com/ManuelZierl/kestral-pi";

function observations() {
  return {
    tested_at: "2026-08-06T12:00:00Z",
    platforms: ["windows-x86_64", "linux-x86_64"],
    lifecycle: Object.fromEntries(LIFECYCLE_CHECKS.map((check) => [check, {
      status: "passed",
      observation: `Manual host observation for ${check}.`,
    }])),
  };
}

function environment() {
  return {
    GITHUB_SERVER_URL: "https://github.com",
    GITHUB_REPOSITORY: "ManuelZierl/kestral-pi",
    GITHUB_RUN_ID: "12345",
    GITHUB_SHA: HEAD,
  };
}

function packageDocument(backend = EXPECTED_BACKEND) {
  return {
    id: APP_ID,
    version: "0.1.3",
    backend,
    data: { kind: "none" },
    manifest: {
      capabilities: [{ name: "agent.run" }],
      artifact_types: [{ name: "agent-transcript" }],
    },
    integrity: { algorithm: "sha256", assets: { "backend/worker.mjs": "sha256-ignored" } },
  };
}

async function fixture(backend = EXPECTED_BACKEND) {
  const root = await mkdtemp(join(tmpdir(), "kestral-pi-release-evidence-"));
  await mkdir(join(root, "dist", "backend"), { recursive: true });
  await writeFile(join(root, "dist", "backend", "worker.mjs"), "export {};\n");
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "kestral-pi-worker", version: "0.1.3" }));
  await writeFile(join(root, "dist", "app.json"), JSON.stringify(packageDocument(backend)));
  return root;
}

async function context(root, expectedPackageDigest) {
  expectedPackageDigest ??= await packageDigest(join(root, "dist"));
  return {
    root,
    observations: observations(),
    expectedPackageDigest,
    expectedAppId: APP_ID,
    expectedRepository: REPOSITORY,
    hostVersion: "0.1.0-alpha.1",
    hostCommit: HEAD,
    env: environment(),
    git: (args) => args[0] === "rev-parse" ? HEAD : "",
  };
}

test("derives an Actions URL only from the GitHub run environment", () => {
  assert.equal(workflowUrl(environment()), "https://github.com/ManuelZierl/kestral-pi/actions/runs/12345");
  assert.throws(() => workflowUrl({ GITHUB_REPOSITORY: "owner/repo", GITHUB_RUN_ID: "1" }), /GITHUB_SERVER_URL/);
});

test("requires exactly the nine passed lifecycle observations", () => {
  const value = observations();
  assert.deepEqual(Object.keys(value.lifecycle).sort(), [...LIFECYCLE_CHECKS].sort());
  assert.throws(() => validateObservations({ ...value, unexpected: true }), /fields differ/);
  assert.throws(() => validateObservations({ ...value, lifecycle: { ...value.lifecycle, extra: { status: "passed", observation: "x" } } }), /fields differ/);
  assert.throws(() => validateObservations({ ...value, lifecycle: { ...value.lifecycle, restart: { status: "failed", observation: "x" } } }), /must be 'passed'/);
  assert.throws(() => validateObservations({ ...value, lifecycle: { ...value.lifecycle, representative_action: undefined } }), /must be an object/);
});

test("accepts the declared agent-worker package and records its contract", async () => {
  const root = await fixture();
  const evidence = await createEvidence(await context(root));
  assert.deepEqual(Object.keys(evidence).sort(), [
    "app",
    "extension_contributions",
    "format_version",
    "host",
    "lifecycle",
    "package",
    "run",
    "source",
  ]);
  assert.deepEqual(evidence.app, { id: APP_ID, version: "0.1.3" });
  assert.equal(evidence.source.clean, true);
  assert.equal(evidence.package.digest, await packageDigest(join(root, "dist")));
  assert.deepEqual(evidence.package, { digest: await packageDigest(join(root, "dist")) });
  assert.deepEqual(evidence.extension_contributions, []);
  assert.equal(evidence.run.workflow_url, "https://github.com/ManuelZierl/kestral-pi/actions/runs/12345");
});

test("rejects a backend-free package instead of treating it as valid evidence", async () => {
  const root = await fixture({ kind: "none" });
  const base = await context(root);
  await assert.rejects(() => createEvidence(base), /agent-worker/);
});

test("binds evidence to the exact source, digest, identity, and clean checkout", async () => {
  const root = await fixture();
  const base = await context(root);
  await assert.rejects(() => createEvidence({ ...base, expectedPackageDigest: "sha256-0000000000000000000000000000000000000000000000000000000000000000" }), /package digest mismatch/);
  await assert.rejects(() => createEvidence({ ...base, env: { ...base.env, GITHUB_SHA: "fedcba9876543210fedcba9876543210fedcba98" } }), /does not match source HEAD/);
  await assert.rejects(() => createEvidence({ ...base, expectedAppId: "com.example.other" }), /app identity/);
  await assert.rejects(() => createEvidence({ ...base, git: (args) => args[0] === "rev-parse" ? HEAD : " M package.json" }), /source checkout is not clean/);
});
