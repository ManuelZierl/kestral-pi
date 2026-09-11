import assert from "node:assert/strict";
import test from "node:test";
import { runAgent, type AgentHostBridge } from "../src/agent-service.ts";
import type { AgentRunCommand, WorkerEvent } from "../src/protocol.ts";

const command: AgentRunCommand = { command: "agent-run", request_id: "run", messages: [{ role: "user", content: "answer" }], tools: [], max_turns: 2 };

for (const max_turns of [1, 2]) {
  test(`a truncated final answer is not reported as successful at turn budget ${max_turns}`, async () => {
    const events: WorkerEvent[] = [];
    const bridge: AgentHostBridge = {
      generate: async () => ({ message: { role: "assistant", content: "The incomplete answer is" }, finish_reason: "length" }),
      invokeTool: async () => { throw new Error("unexpected tool"); },
    };
    await runAgent({ ...command, max_turns }, bridge, (event) => events.push(event), new AbortController().signal);
    assert.equal(events.some((event) => event.type === "completed"), false);
    assert.equal(events.filter((event) => event.type === "failed" && event.code === "model-truncated").length, 1);
  });
}

test("truncated tool calls remain recoverable without executing incomplete arguments", async () => {
  let calls = 0;
  let invoked = false;
  const events: WorkerEvent[] = [];
  const bridge: AgentHostBridge = {
    generate: async (_id, _model, messages) => {
      if (++calls === 1) return { message: { role: "assistant", content: "", tool_calls: [{ id: "partial", type: "function", function: { name: "read", arguments: "{}" } }] }, finish_reason: "length" };
      assert.match([...messages].reverse().find((message) => message.role === "tool")?.content ?? "", /not executed/);
      return { message: { role: "assistant", content: "recovered" }, finish_reason: "stop" };
    },
    invokeTool: async () => { invoked = true; return { outcome: "completed", content: "unexpected" }; },
  };
  await runAgent({ ...command, tools: [{ type: "function", function: { name: "read", description: "Read", parameters: { type: "object", properties: {} } } }] }, bridge, (event) => events.push(event), new AbortController().signal);
  assert.equal(invoked, false);
  assert.equal(calls, 2);
  assert.equal(events.some((event) => event.type === "failed"), false);
  assert.equal(events.some((event) => event.type === "completed" && event.text === "recovered" && event.finish_reason === "stop"), true);
});
