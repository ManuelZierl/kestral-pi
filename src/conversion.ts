import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Message, ToolCall, Usage } from "@earendil-works/pi-ai";
import type { HostLlmResponse, HostMessage, HostToolCall } from "./protocol.ts";

const emptyUsage = (): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });

const toolCall = (call: HostToolCall): ToolCall => ({
  type: "toolCall",
  id: call.id,
  name: call.function.name,
  arguments: JSON.parse(call.function.arguments) as Record<string, unknown>,
});

export function fromHostMessages(messages: HostMessage[]): AgentMessage[] {
  return messages.flatMap((message): AgentMessage[] => {
    if (message.role === "system") throw new Error("system messages must be moved to the agent system prompt");
    if (message.role === "user") return [{ role: "user", content: message.content, timestamp: Date.now() }];
    if (message.role === "tool") {
      if (!message.tool_call_id || !message.name) throw new Error("tool messages require tool_call_id and name");
      return [{ role: "toolResult", toolCallId: message.tool_call_id, toolName: message.name, content: [{ type: "text", text: message.content }], isError: false, timestamp: Date.now() }];
    }
    return [{ role: "assistant", content: [
      ...(message.content ? [{ type: "text" as const, text: message.content }] : []),
      ...(message.tool_calls ?? []).map(toolCall),
    ], api: "kestral", provider: "kestral", model: "host-routed", usage: emptyUsage(), stopReason: message.tool_calls?.length ? "toolUse" : "stop", timestamp: Date.now() }];
  });
}

export function toHostMessages(messages: Message[]): HostMessage[] {
  return messages.map((message): HostMessage => {
    if (message.role === "user") return { role: "user", content: typeof message.content === "string" ? message.content : message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n") };
    if (message.role === "toolResult") return { role: "tool", content: message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n"), tool_call_id: message.toolCallId, name: message.toolName };
    return { role: "assistant", content: message.content.filter((part) => part.type === "text").map((part) => part.text).join(""), tool_calls: message.content.filter((part): part is ToolCall => part.type === "toolCall").map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) };
  });
}

export function assistantFromHost(response: HostLlmResponse, model: string): AssistantMessage {
  if (response.message.role !== "assistant") throw new Error("LLM response message must be assistant");
  const content = [
    ...(response.reasoning ? [{ type: "thinking" as const, thinking: response.reasoning }] : []),
    ...(response.message.content ? [{ type: "text" as const, text: response.message.content }] : []),
    ...(response.message.tool_calls ?? []).map(toolCall),
  ];
  const stopReason = response.finish_reason === "length"
    ? "length"
    : response.message.tool_calls?.length
      ? "toolUse"
      : response.finish_reason === "stop"
        ? "stop"
        : (() => { throw new Error(`unsupported LLM finish reason ${response.finish_reason}`); })();
  return { role: "assistant", content, api: "kestral", provider: "kestral", model, usage: emptyUsage(), stopReason, timestamp: Date.now() };
}

export function assistantReasoning(message: AssistantMessage | undefined): string | undefined {
  const reasoning = message?.content
    .filter((part) => part.type === "thinking")
    .map((part) => part.thinking)
    .join("");
  return reasoning || undefined;
}
