import assert from "node:assert/strict";
import test from "node:test";
import { parseCommand } from "../src/protocol.ts";

test("protocol rejects unknown fields", () => {
  assert.throws(() => parseCommand({ command: "shutdown", request_id: "r", secret: "no" }), /unknown field secret/);
});

test("agent run validates turn bounds", () => {
  assert.throws(() => parseCommand({ command: "agent-run", request_id: "r", messages: [{ role: "user", content: "hi" }], tools: [], max_turns: 11 }), /between 1 and 10/);
});

test("protocol rejects malformed nested messages and tool results", () => {
  assert.throws(
    () => parseCommand({ command: "agent-run", request_id: "r", messages: [{ role: "tool", content: "result", name: "read" }], tools: [], max_turns: 2 }),
    /tool_call_id/,
  );
  assert.throws(
    () => parseCommand({ command: "tool-result", request_id: "r", target_request_id: "run", tool_call_id: "call", outcome: "maybe", content: "result" }),
    /invalid tool outcome/,
  );
  assert.throws(
    () => parseCommand({ command: "llm-completed", request_id: "r", call_id: "call", response: { message: { role: "assistant", content: "ok", credential: "no" }, finish_reason: "stop" } }),
    /unknown field credential/,
  );
});

test("protocol enforces conversation and LLM response semantics", () => {
  assert.throws(
    () => parseCommand({ command: "agent-run", request_id: "r", messages: [{ role: "assistant", content: "done" }], tools: [], max_turns: 2 }),
    /must end with a user or tool message/,
  );
  assert.throws(
    () => parseCommand({ command: "llm-completed", request_id: "r", call_id: "call", response: { message: { role: "user", content: "not an answer" }, finish_reason: "stop" } }),
    /must be assistant/,
  );
  assert.throws(
    () => parseCommand({ command: "llm-completed", request_id: "r", call_id: "call", response: { message: { role: "assistant", content: "" }, finish_reason: "tool_calls" } }),
    /requires tool calls/,
  );
  assert.throws(
    () => parseCommand({ command: "llm-completed", request_id: "r", call_id: "call", response: { message: { role: "assistant", content: "", tool_calls: [{ id: "same", type: "function", function: { name: "read", arguments: "{}" } }, { id: "same", type: "function", function: { name: "read", arguments: "{}" } }] }, finish_reason: "tool_calls" } }),
    /ids must be unique/,
  );
});

test("agent run rejects duplicate tool names", () => {
  const tool = { type: "function", function: { name: "read", description: "Read", parameters: { type: "object" } } };
  assert.throws(
    () => parseCommand({ command: "agent-run", request_id: "r", messages: [{ role: "user", content: "go" }], tools: [tool, tool], max_turns: 2 }),
    /tool names must be unique/,
  );
});
