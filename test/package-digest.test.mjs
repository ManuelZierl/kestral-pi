import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { packageDigest } from "../scripts/package-digest.mjs";

test("package digest uses the host's canonical sorted length-prefixed stream", async () => {
  const root = await mkdtemp(join(tmpdir(), "kestral-pi-digest-"));
  try {
    const app = JSON.stringify({
      integrity: { algorithm: "sha256", assets: { "backend/z.txt": "unused", "backend/a.txt": "unused" } },
    });
    await writeFile(join(root, "app.json"), app);
    await mkdir(join(root, "backend"));
    await writeFile(join(root, "backend", "z.txt"), Buffer.from([0, 1, 2]));
    await writeFile(join(root, "backend", "a.txt"), "a\n");

    assert.equal(
      await packageDigest(root),
      "sha256-448c78df7d23509935a656b57356d3f67754753a511235d57a87522b4c5fd5c6",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("package digest rejects unsafe declared paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "kestral-pi-digest-"));
  try {
    await writeFile(
      join(root, "app.json"),
      JSON.stringify({ integrity: { algorithm: "sha256", assets: { "backend/../worker.mjs": "unused" } } }),
    );
    await assert.rejects(packageDigest(root), /unsafe package path/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
