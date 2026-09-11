import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("package declares the narrowed agent contract and matching worker integrity", async () => {
  const app = JSON.parse(await readFile(new URL("../dist/app.json", import.meta.url), "utf8"));
  const worker = await readFile(new URL("../dist/backend/worker.mjs", import.meta.url));
  const packagedNotices = await readFile(new URL("../dist/backend/THIRD-PARTY-NOTICES.txt", import.meta.url));
  const sourceNotices = await readFile(new URL("../THIRD-PARTY-NOTICES.txt", import.meta.url));
  const agent = app.manifest.capabilities.find((capability: { name: string }) => capability.name === "agent.run");

  assert.equal(app.version, "0.1.3");
  assert.equal(
    app.min_host_version,
    "0.1.0-alpha.1",
    "stable 0.1.0 sorts after the planned alpha host and would refuse installation",
  );
  assert.equal(app.backend.authority_mode, "unsandboxed");
  assert.deepEqual(app.data, { kind: "none" });
  assert.deepEqual(app.manifest.grant_requests ?? [], []);
  assert.equal(Object.keys(app.integrity.assets).every((path) => /^(ui|backend)\//.test(path)), true);
  assert.equal(agent.input_schema.properties.tools.properties.allow_capabilities.uniqueItems, true);
  assert.equal(agent.input_schema.properties.temperature.maximum, 2);
  assert.equal(agent.input_schema.properties.max_output_tokens.maximum, 1_000_000);
  assert.equal(
    app.integrity.assets["backend/worker.mjs"],
    `sha256-${createHash("sha256").update(worker).digest("hex")}`,
  );
  assert.deepEqual(packagedNotices, sourceNotices);
  assert.match(sourceNotices.toString(), /@earendil-works\/pi-agent-core@0\.80\.7/);
  assert.equal(
    app.integrity.assets["backend/THIRD-PARTY-NOTICES.txt"],
    `sha256-${createHash("sha256").update(packagedNotices).digest("hex")}`,
  );
});
