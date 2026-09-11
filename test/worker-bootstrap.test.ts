import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";

test("bundled entrypoint clears credentials before evaluating agent dependencies", async () => {
  const bundled = await build({
    entryPoints: [fileURLToPath(new URL("../src/worker.ts", import.meta.url))],
    bundle: true, write: false, platform: "node", format: "esm", target: "node22.19",
    plugins: [{
      name: "observe-dependency-initialization",
      setup(builder) {
        builder.onResolve({ filter: /\/(agent-service|runner)\.ts$/ }, (args) => ({ path: args.path, namespace: "initialization-test" }));
        builder.onLoad({ filter: /.*/, namespace: "initialization-test" }, (args) => ({
          contents: args.path.endsWith("agent-service.ts")
            ? `if (process.env.KESTRAL_BOOTSTRAP_SENTINEL !== undefined) throw new Error("credentials visible during dependency initialization"); export async function runAgent() {}`
            : `import { runAgent } from "./agent-service.ts"; export async function runWorker(run = runAgent) { if (typeof run !== "function") throw new Error("missing runner"); console.log("sanitized"); }`,
          loader: "js",
        }));
      },
    }],
  });
  const result = spawnSync(process.execPath, ["--input-type=module"], {
    input: bundled.outputFiles[0].text,
    encoding: "utf8", timeout: 5_000,
    env: { ...process.env, KESTRAL_BOOTSTRAP_SENTINEL: "test-only-value" },
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "sanitized");
});
