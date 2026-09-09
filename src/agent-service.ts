import { runAgentLoopContinue, type AgentEvent, type AgentLoopConfig, type AgentTool } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, type AssistantMessage, type Context, type Message, type Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { assistantFromHost, assistantReasoning, fromHostMessages, toHostMessages } from "./conversion.ts";
import type { AgentRunCommand, HostLlmResponse, HostMessage, HostTool, WorkerEvent } from "./protocol.ts";

export interface AgentHostBridge {
  generate(requestId: string, model: string, messages: HostMessage[], tools: HostTool[], reasoning: string | undefined, signal: AbortSignal): Promise<HostLlmResponse>;
  invokeTool(requestId: string, toolCallId: string, toolName: string, args: Record<string, unknown>, signal: AbortSignal): Promise<{ outcome: "completed" | "refused" | "failed"; content: string }>;
}

export type Emit = (event: WorkerEvent) => void;

const modelFor = (id: string): Model<any> => ({ id, name: id, api: "kestral", provider: "kestral", baseUrl: "", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1_000_000, maxTokens: 100_000 });

function toolFromHost(requestId: string, tool: HostTool, bridge: AgentHostBridge): AgentTool {
  return {
    name: tool.function.name,
    label: tool.function.name,
    description: tool.function.description,
    parameters: Type.Unsafe(tool.function.parameters),
    executionMode: "sequential",
    execute: async (toolCallId, params, signal) => {
      const result = await bridge.invokeTool(requestId, toolCallId, tool.function.name, params as Record<string, unknown>, signal ?? new AbortController().signal);
      const content = result.outcome === "completed"
        ? result.content
        : `Tool invocation ${result.outcome}: ${result.content}`;
      return { content: [{ type: "text", text: content }], details: { outcome: result.outcome } };
    },
  };
}

export async function runAgent(command: AgentRunCommand, bridge: AgentHostBridge, emit: Emit, signal: AbortSignal): Promise<void> {
  const model = command.model ?? "default";
  const systemPrompt = [
    command.system_prompt,
    ...command.messages.filter((message) => message.role === "system").map((message) => message.content),
  ].filter((value): value is string => Boolean(value)).join("\n\n");
  const messages = fromHostMessages(command.messages.filter((message) => message.role !== "system")) as Message[];
  const tools = command.tools.map((tool) => toolFromHost(command.request_id, tool, bridge));
  let calls = 0;
  let turns = 0;
  let stoppedAtTurnLimit = false;
  let modelFailure: { code: "agent-failed" | "cancelled"; message: string } | undefined;
  const config: AgentLoopConfig = {
    model: modelFor(model),
    convertToLlm: (agentMessages) => agentMessages as Message[],
    toolExecution: "sequential",
    afterToolCall: async ({ result }) => {
      const details = result.details as { outcome?: "completed" | "refused" | "failed" } | undefined;
      return details?.outcome && details.outcome !== "completed" ? { isError: true } : undefined;
    },
    shouldStopAfterTurn: ({ message }) => {
      const needsAnotherTurn = message.role === "assistant"
        && message.content.some((part) => part.type === "toolCall");
      stoppedAtTurnLimit = calls >= command.max_turns && needsAnotherTurn;
      return stoppedAtTurnLimit;
    },
  };
  const stream = async (_model: Model<any>, context: Context, options?: { signal?: AbortSignal }) => {
    const stream = createAssistantMessageEventStream();
    calls += 1;
    queueMicrotask(async () => {
      try {
        if (signal.aborted || options?.signal?.aborted) throw new Error("agent request cancelled");
        const hostMessages: HostMessage[] = [
          ...(context.systemPrompt ? [{ role: "system" as const, content: context.systemPrompt }] : []),
          ...toHostMessages(context.messages),
        ];
        const response = await bridge.generate(command.request_id, model, hostMessages, command.tools, command.reasoning, options?.signal ?? signal);
        const message = assistantFromHost(response, model);
        stream.push({ type: "start", partial: message });
        stream.push({ type: "done", reason: message.stopReason === "length" ? "length" : message.stopReason === "toolUse" ? "toolUse" : "stop", message });
      } catch (error) {
        const cancelled = signal.aborted || options?.signal?.aborted === true;
        const errorMessage = error instanceof Error ? error.message : "model call failed";
        modelFailure = { code: cancelled ? "cancelled" : "agent-failed", message: errorMessage };
        const message: AssistantMessage = { ...assistantFromHost({ message: { role: "assistant", content: "" }, finish_reason: "stop" }, model), stopReason: cancelled ? "aborted" : "error", errorMessage };
        stream.push({ type: "error", reason: message.stopReason as "aborted" | "error", error: message });
      }
    });
    return stream;
  };

  const context = { systemPrompt, messages, tools };
  const onEvent = (event: AgentEvent) => {
    if (event.type === "turn_end") turns += 1;
    if (["turn_start", "turn_end", "tool_execution_start", "tool_execution_end"].includes(event.type)) emit({ type: "agent-event", request_id: command.request_id, event: event.type, ...(("toolCallId" in event) ? { tool_call_id: event.toolCallId, tool_name: event.toolName } : {}) });
  };
  try {
    if (signal.aborted) throw new Error("agent request cancelled");
    await runAgentLoopContinue(context, config, onEvent, signal, stream);
    if (modelFailure) {
      emit({ type: "failed", request_id: command.request_id, code: modelFailure.code, message: modelFailure.message });
      return;
    }
    if (signal.aborted) throw new Error("agent request cancelled");
    const transcript = toHostMessages(context.messages);
    const last = [...context.messages].reverse().find((message): message is AssistantMessage => message.role === "assistant");
    // Protocol v1 has no successful "length" result. Do not label a cut-off
    // final answer as "stop". Pi may still recover truncated tool calls while
    // there are turns left; an exhausted tool loop remains "max-turns".
    if (last?.stopReason === "length" && !stoppedAtTurnLimit) {
      emit({ type: "failed", request_id: command.request_id, code: "model-truncated", message: "Model output reached its token limit before completing the answer." });
      return;
    }
    const reasoning = assistantReasoning(last);
    emit({
      type: "completed",
      request_id: command.request_id,
      text: last?.content.filter((part) => part.type === "text").map((part) => part.text).join("") ?? "",
      ...(reasoning ? { reasoning } : {}),
      finish_reason: stoppedAtTurnLimit ? "max-turns" : "stop",
      turns,
      transcript,
    });
  } catch (error) {
    emit({ type: "failed", request_id: command.request_id, code: signal.aborted ? "cancelled" : "agent-failed", message: error instanceof Error ? error.message : "agent failed" });
  }
}
