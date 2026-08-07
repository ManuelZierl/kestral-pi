import assert from "node:assert/strict";
import test from "node:test";
import { assistantFromHost, assistantReasoning, fromHostMessages, toHostMessages } from "../src/conversion.ts";

test("host tool calls round trip through pi messages", () => {
  const host = [{ role: "assistant" as const, content: "", tool_calls: [{ id: "c", type: "function" as const, function: { name: "notes_read", arguments: "{\"id\":1}" } }] }];
  assert.deepEqual(toHostMessages(fromHostMessages(host) as any)[0].tool_calls, host[0].tool_calls);
});

test("host response becomes a pi assistant message", () => {
  const message = assistantFromHost({ message: { role: "assistant", content: "ok" }, reasoning: "think", finish_reason: "stop" }, "model");
  assert.equal(message.stopReason, "stop");
  assert.equal(message.content.some((part) => part.type === "text" && part.text === "ok"), true);
  assert.equal(assistantReasoning(message), "think");
});

test("length responses never execute partial tool calls", () => {
  const message = assistantFromHost({
    message: { role: "assistant", content: "", tool_calls: [{ id: "c", type: "function", function: { name: "read", arguments: "{}" } }] },
    finish_reason: "length",
  }, "model");
  assert.equal(message.stopReason, "length");
});

test("system messages require explicit prompt handling", () => {
  assert.throws(() => fromHostMessages([{ role: "system", content: "rules" }]), /system prompt/);
});
