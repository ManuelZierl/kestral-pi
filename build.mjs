import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import { createThirdPartyNotices } from "./scripts/generate-third-party-notices.mjs";

const here = dirname(fileURLToPath(import.meta.url));

const dist = join(here, "dist");
const worker = join(dist, "backend", "worker.mjs");
const notices = createThirdPartyNotices(here);
const packageVersion = JSON.parse(await readFile(join(here, "package.json"), "utf8")).version;
await writeFile(join(here, "THIRD-PARTY-NOTICES.txt"), notices);
await rm(dist, { recursive: true, force: true });
await mkdir(dirname(worker), { recursive: true });
await esbuild.build({
  entryPoints: [join(here, "src", "worker.ts")],
  outfile: worker,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22.19",
  nodePaths: [join(here, "node_modules")],
  banner: {
    js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
  },
  logLevel: "warning",
});

const workerDigest = createHash("sha256").update(await readFile(worker)).digest("hex");
await writeFile(join(dist, "backend", "THIRD-PARTY-NOTICES.txt"), notices);
const noticesDigest = createHash("sha256").update(notices).digest("hex");
const app = {
  format_version: 1,
  id: "com.ma-zierl.kestral-pi",
  version: packageVersion,
  display_name: "Agent Engine (pi)",
  description: "Runs multi-turn pi agents while routing every model and tool call through Kestral permissions.",
  publisher: { name: "Kestral" },
  license: "MIT",
  min_host_version: "0.1.0-alpha.1",
  manifest: {
    capabilities: [{
      name: "agent.run",
      description: "Run a bounded multi-turn agent over the caller's granted capabilities.",
      input_schema: {
        type: "object",
        properties: {
          messages: { type: "array", minItems: 1, items: { type: "object" } },
          system_prompt: { type: "string" },
          profile: { type: "string" },
          model: { type: "string" },
          reasoning: { type: "string" },
          temperature: { type: "number", minimum: 0, maximum: 2 },
          max_output_tokens: { type: "integer", minimum: 1, maximum: 1000000 },
          max_turns: { type: "integer", minimum: 1, maximum: 10 },
          max_payload_bytes: { type: "integer", minimum: 1 },
          max_duration_secs: { type: "integer", minimum: 1 },
          tools: {
            type: "object",
            properties: {
              exclude_providers: { type: "array", items: { type: "string", minLength: 1 }, uniqueItems: true },
              allow_capabilities: { type: "array", items: { type: "string", minLength: 3 }, uniqueItems: true },
            },
            additionalProperties: false,
          },
          progress: { type: "boolean" },
          cancellation: { type: "boolean" },
          recursion_guard: { type: "boolean" },
          credential_isolation: { type: "boolean" },
        },
        required: ["messages"],
        additionalProperties: false,
      },
      effect: "external-write",
      output_schema: {
        type: "object",
        properties: {
          text: { type: "string" },
          reasoning: { type: "string" },
          finish_reason: { enum: ["stop", "max-turns", "cancelled", "failed"] },
          turns: { type: "integer", minimum: 0 },
          failure_reason: { type: ["string", "null"] },
        },
        required: ["text", "finish_reason", "turns"],
        additionalProperties: false,
      },
    }],
    config_declarations: [{
      name: "agent",
      title: "Agent engine limits",
      description: "Host-enforced maximum duration for an agent run.",
      json_schema: {
        type: "object",
        properties: { max_duration_secs: { type: "integer", minimum: 60, maximum: 3600 } },
        required: ["max_duration_secs"],
        additionalProperties: false,
      },
      default: { max_duration_secs: 600 },
    }],
    artifact_types: [{
      name: "agent-transcript",
      description: "Complete model and tool transcript from an agent run.",
      json_schema: { type: "array", items: { type: "object" } },
    }],
  },
  consumer_grant_requests: [{
    holder: "chat",
    request: {
      scope: { kind: "exact-capability", provider: "com.ma-zierl.kestral-pi", capability: "agent.run" },
      data_scope: { kind: "none" },
      condition: "silent",
      reason: "Let Chat delegate conversations to the installed pi agent engine.",
      duration: { kind: "non-expiring" },
    },
  }],
  backend: {
    kind: "agent-worker",
    authority_mode: "unsandboxed",
    protocol_version: 1,
    entry: "backend/worker.mjs",
  },
  data: { kind: "none" },
  integrity: {
    algorithm: "sha256",
    assets: {
      "backend/worker.mjs": `sha256-${workerDigest}`,
      "backend/THIRD-PARTY-NOTICES.txt": `sha256-${noticesDigest}`,
    },
  },
};
await writeFile(join(dist, "app.json"), `${JSON.stringify(app, null, 2)}\n`);
