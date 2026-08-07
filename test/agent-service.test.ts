import assert from "node:assert/strict";
import test from "node:test";
import { runAgent, type AgentHostBridge } from "../src/agent-service.ts";
import type { AgentRunCommand, HostTool, WorkerEvent } from "../src/protocol.ts";

const noteTool: HostTool = {
  type: "function",
  function: {
    name: "notes_read",
    description: "Read a note",
    parameters: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
  },
};

const command = (overrides: Partial<AgentRunCommand> = {}): AgentRunCommand => ({
  command: "agent-run",
  request_id: "run-1",
  messages: [{ role: "user", content: "Read the note" }],
  tools: [],
  max_turns: 4,
  ...overrides,
});

const completedEvent = (events: WorkerEvent[]) => events.find((event) => event.type === "completed");
const failedEvent = (events: WorkerEvent[]) => events.find((event) => event.type === "failed");

test("real pi agent loop performs a host-routed model-tool-model loop", async () => {
  let modelCalls = 0;
  const toolCalls: string[] = [];
  const bridge: AgentHostBridge = {
    generate: async () => {
      modelCalls += 1;
      if (modelCalls === 1) {
        return {
          message: {
            role: "assistant",
            content: "",
            tool_calls: [{ id: "tool-1", type: "function", function: { name: "notes_read", arguments: "{\"id\":\"n1\"}" } }],
          },
          finish_reason: "tool_calls",
        };
      }
      return { message: { role: "assistant", content: "The note says hello." }, finish_reason: "stop" };
    },
    invokeTool: async (_requestId, _toolCallId, toolName) => {
      toolCalls.push(toolName);
      return { outcome: "completed", content: "hello" };
    },
  };
  const events: WorkerEvent[] = [];

  await runAgent(
    command({ tools: [noteTool] }),
    bridge,
    (event) => events.push(event),
    new AbortController().signal,
  );

  assert.equal(modelCalls, 2);
  assert.deepEqual(toolCalls, ["notes_read"]);
  const completed = completedEvent(events);
  assert.equal(completed?.type === "completed" && completed.text, "The note says hello.");
});

test("system instructions reach every host-routed model call and final reasoning is retained", async () => {
  const generatedMessages: Parameters<AgentHostBridge["generate"]>[2][] = [];
  let calls = 0;
  const bridge: AgentHostBridge = {
    generate: async (_requestId, _model, messages) => {
      generatedMessages.push(messages);
      calls += 1;
      if (calls === 1) {
        return {
          message: { role: "assistant", content: "", tool_calls: [{ id: "tool-1", type: "function", function: { name: "notes_read", arguments: "{\"id\":\"n1\"}" } }] },
          finish_reason: "tool_calls",
        };
      }
      return { message: { role: "assistant", content: "answer" }, reasoning: "final thought", finish_reason: "stop" };
    },
    invokeTool: async () => ({ outcome: "completed", content: "hello" }),
  };
  const events: WorkerEvent[] = [];

  await runAgent(
    command({
      system_prompt: "Primary rules",
      messages: [{ role: "system", content: "Conversation rules" }, { role: "user", content: "go" }],
      tools: [noteTool],
    }),
    bridge,
    (event) => events.push(event),
    new AbortController().signal,
  );

  assert.equal(generatedMessages.length, 2);
  assert.deepEqual(generatedMessages.map((messages) => messages[0]), [
    { role: "system", content: "Primary rules\n\nConversation rules" },
    { role: "system", content: "Primary rules\n\nConversation rules" },
  ]);
  const completed = completedEvent(events);
  assert.equal(completed?.type === "completed" && completed.reasoning, "final thought");
});

test("model failures fail the agent instead of fabricating empty success", async () => {
  const bridge: AgentHostBridge = {
    generate: async () => { throw new Error("provider unavailable"); },
    invokeTool: async () => ({ outcome: "completed", content: "unused" }),
  };
  const events: WorkerEvent[] = [];

  await runAgent(command(), bridge, (event) => events.push(event), new AbortController().signal);

  assert.equal(completedEvent(events), undefined);
  const failed = failedEvent(events);
  assert.equal(failed?.type === "failed" && failed.code, "agent-failed");
  assert.equal(failed?.type === "failed" && failed.message, "provider unavailable");
});

test("turn limit stops after the last real turn without a synthetic error turn", async () => {
  let modelCalls = 0;
  const bridge: AgentHostBridge = {
    generate: async () => {
      modelCalls += 1;
      return {
        message: { role: "assistant", content: "checking", tool_calls: [{ id: "tool-1", type: "function", function: { name: "notes_read", arguments: "{\"id\":\"n1\"}" } }] },
        finish_reason: "tool_calls",
      };
    },
    invokeTool: async () => ({ outcome: "completed", content: "hello" }),
  };
  const events: WorkerEvent[] = [];

  await runAgent(command({ tools: [noteTool], max_turns: 1 }), bridge, (event) => events.push(event), new AbortController().signal);

  assert.equal(modelCalls, 1);
  const completed = completedEvent(events);
  assert.equal(completed?.type === "completed" && completed.finish_reason, "max-turns");
  assert.equal(completed?.type === "completed" && completed.turns, 1);
  assert.equal(completed?.type === "completed" && completed.text, "checking");
  assert.deepEqual(completed?.type === "completed" && completed.transcript.map((message) => message.role), ["user", "assistant", "tool"]);
});

test("truncated tool calls are not executed", async () => {
  let toolCalls = 0;
  const bridge: AgentHostBridge = {
    generate: async () => ({
      message: { role: "assistant", content: "", tool_calls: [{ id: "partial", type: "function", function: { name: "notes_read", arguments: "{\"id\":\"n1\"}" } }] },
      finish_reason: "length",
    }),
    invokeTool: async () => {
      toolCalls += 1;
      return { outcome: "completed", content: "must not run" };
    },
  };
  const events: WorkerEvent[] = [];

  await runAgent(command({ tools: [noteTool], max_turns: 1 }), bridge, (event) => events.push(event), new AbortController().signal);

  assert.equal(toolCalls, 0);
  assert.equal(completedEvent(events)?.type === "completed" && completedEvent(events)?.finish_reason, "max-turns");
});

test("tool refusals remain distinguishable in subsequent model context", async () => {
  let calls = 0;
  let refusedResult = "";
  const bridge: AgentHostBridge = {
    generate: async (_requestId, _model, messages) => {
      calls += 1;
      if (calls === 1) {
        return {
          message: { role: "assistant", content: "", tool_calls: [{ id: "tool-1", type: "function", function: { name: "notes_read", arguments: "{\"id\":\"n1\"}" } }] },
          finish_reason: "tool_calls",
        };
      }
      refusedResult = [...messages].reverse().find((message) => message.role === "tool")?.content ?? "";
      return { message: { role: "assistant", content: "cannot read" }, finish_reason: "stop" };
    },
    invokeTool: async () => ({ outcome: "refused", content: "permission denied" }),
  };

  await runAgent(command({ tools: [noteTool] }), bridge, () => {}, new AbortController().signal);

  assert.equal(refusedResult, "Tool invocation refused: permission denied");
});

test("pre-cancelled runs fail without starting a model request", async () => {
  let generated = false;
  const bridge: AgentHostBridge = {
    generate: async () => {
      generated = true;
      return { message: { role: "assistant", content: "late" }, finish_reason: "stop" };
    },
    invokeTool: async () => ({ outcome: "completed", content: "unused" }),
  };
  const controller = new AbortController();
  controller.abort();
  const events: WorkerEvent[] = [];

  await runAgent(command(), bridge, (event) => events.push(event), controller.signal);

  assert.equal(generated, false);
  assert.equal(failedEvent(events)?.type === "failed" && failedEvent(events)?.code, "cancelled");
});
