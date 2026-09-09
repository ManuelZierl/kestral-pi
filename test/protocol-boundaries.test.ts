import assert from "node:assert/strict";
import test from "node:test";
import { parseCommand } from "../src/protocol.ts";

const run = { command: "agent-run", request_id: "run", messages: [{ role: "user", content: "hello" }], tools: [], max_turns: 2 };

test("unknown empty field names are rejected at every object boundary", () => {
  for (const value of [
    { ...run, "": true },
    { ...run, messages: [{ role: "user", content: "hello", "": true }] },
    { ...run, tools: [{ type: "function", function: { name: "read", description: "", parameters: {}, "": true } }] },
  ]) assert.throws(() => parseCommand(value), /unknown field/);
});

test("tool outcomes must be strings, not coercible arrays", () => {
  for (const outcome of [["completed"], ["refused"], ["failed"], null, {}]) {
    assert.throws(() => parseCommand({ command: "tool-result", request_id: "reply", target_request_id: "run", tool_call_id: "tool", outcome, content: "result" }), /invalid tool outcome/);
  }
});

test("worker turn bounds agree with the host and package contract", () => {
  assert.doesNotThrow(() => parseCommand({ ...run, max_turns: 10 }));
  for (const max_turns of [0, 11, 50, 1.5]) {
    assert.throws(() => parseCommand({ ...run, max_turns }), /max_turns/);
  }
});

test("optional text may be empty without accepting empty identities", () => {
  assert.doesNotThrow(() => parseCommand({ ...run, system_prompt: "", reasoning: "" }));
  assert.doesNotThrow(() => parseCommand({ command: "llm-completed", request_id: "reply", call_id: "call", response: { message: { role: "assistant", content: "answer" }, finish_reason: "stop", reasoning: "" } }));
  assert.throws(() => parseCommand({ ...run, model: "" }), /model/);
  assert.throws(() => parseCommand({ ...run, request_id: "" }), /request_id/);
});
