import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { packageDigest } from "../scripts/package-digest.mjs";

async function fixture(t, assets) {
  const root = await mkdtemp(join(tmpdir(), "pi-digest-boundary-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "app.json"), JSON.stringify({ integrity: { algorithm: "sha256", assets } }));
  return root;
}

test("digest rejects case-colliding asset paths", async (t) => {
  const root = await fixture(t, { "A.txt": "ignored", "a.txt": "ignored" });
  await assert.rejects(packageDigest(root), /case-colliding/);
});

test("digest rejects a case alias of app.json", async (t) => {
  const root = await fixture(t, { "APP.JSON": "ignored" });
  await assert.rejects(packageDigest(root), /case-colliding/);
});

test("digest does not follow an intermediate directory symlink", async (t) => {
  const root = await fixture(t, { "backend/worker.mjs": "ignored" });
  const outside = await mkdtemp(join(tmpdir(), "pi-digest-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, "worker.mjs"), "outside package");
  await symlink(outside, join(root, "backend"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(packageDigest(root), /not a directory|symbolic link/);
});

test("digest still accepts ordinary nested regular files", async (t) => {
  const root = await fixture(t, { "backend/worker.mjs": "ignored" });
  await mkdir(join(root, "backend"));
  await writeFile(join(root, "backend", "worker.mjs"), "worker");
  assert.match(await packageDigest(root), /^sha256-[0-9a-f]{64}$/);
});
