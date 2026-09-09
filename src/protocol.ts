export const PROTOCOL_VERSION = 1;

export interface HostMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: HostToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface HostToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface HostTool {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export type AgentRunCommand = {
  command: "agent-run";
  request_id: string;
  system_prompt?: string;
  messages: HostMessage[];
  tools: HostTool[];
  model?: string;
  reasoning?: string;
  max_turns: number;
};

export type HostCommand =
  | AgentRunCommand
  | { command: "tool-result"; request_id: string; target_request_id: string; tool_call_id: string; outcome: "completed" | "refused" | "failed"; content: string }
  | { command: "llm-completed"; request_id: string; call_id: string; response: HostLlmResponse }
  | { command: "llm-failed"; request_id: string; call_id: string; message: string }
  | { command: "cancel"; request_id: string; target_request_id: string }
  | { command: "shutdown"; request_id: string };

export interface HostLlmResponse {
  message: HostMessage;
  reasoning?: string;
  finish_reason: string;
}

export type WorkerEvent =
  | { type: "ready"; protocol_version: number }
  | { type: "llm-request"; request_id: string; call_id: string; model: string; messages: HostMessage[]; tools: HostTool[]; reasoning?: string }
  | { type: "tool-request"; request_id: string; tool_call_id: string; tool_name: string; arguments: Record<string, unknown> }
  | { type: "agent-event"; request_id: string; event: string; tool_call_id?: string; tool_name?: string }
  | { type: "completed"; request_id: string; text: string; reasoning?: string; finish_reason: "stop" | "max-turns"; turns: number; transcript: HostMessage[] }
  | { type: "failed"; request_id: string; code: string; message: string }
  | { type: "acknowledged"; request_id: string; command: "cancel" | "shutdown"; target_request_id?: string };

export class ProtocolError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

const object = (value: unknown, label: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new ProtocolError("invalid-command", `${label} must be an object`);
  return value as Record<string, unknown>;
};

const exactKeys = (value: Record<string, unknown>, allowed: readonly string[]): void => {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown !== undefined) throw new ProtocolError("invalid-command", `unknown field ${unknown}`);
};

const string = (value: unknown, label: string, maximum = 16_384): string => {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) throw new ProtocolError("invalid-command", `${label} has invalid length`);
  return value;
};

const text = (value: unknown, label: string, maximum = 2 * 1024 * 1024): string => {
  if (typeof value !== "string" || value.length > maximum) throw new ProtocolError("invalid-command", `${label} has invalid length`);
  return value;
};

const optionalText = (value: unknown, label: string): void => {
  if (value !== undefined) text(value, label, 16_384);
};

function validateToolCall(value: unknown): string {
  const raw = object(value, "tool call");
  exactKeys(raw, ["id", "type", "function"]);
  string(raw.id, "tool call id", 128);
  if (raw.type !== "function") throw new ProtocolError("invalid-command", "tool call type must be function");
  const fn = object(raw.function, "tool call function");
  exactKeys(fn, ["name", "arguments"]);
  string(fn.name, "tool call name", 128);
  const args = text(fn.arguments, "tool call arguments");
  let parsedValue: unknown;
  try {
    parsedValue = JSON.parse(args);
  } catch {
    throw new ProtocolError("invalid-command", "tool call arguments must be valid JSON");
  }
  const parsed = object(parsedValue, "tool call arguments");
  if (Object.keys(parsed).length > 256) throw new ProtocolError("invalid-command", "tool call has too many arguments");
  return raw.id as string;
}

function validateMessage(value: unknown): HostMessage["role"] {
  const raw = object(value, "message");
  const role = string(raw.role, "message role", 16);
  text(raw.content, "message content");
  if (role === "system" || role === "user") {
    exactKeys(raw, ["role", "content"]);
  } else if (role === "assistant") {
    exactKeys(raw, ["role", "content", "tool_calls"]);
    if (raw.tool_calls !== undefined) {
      if (!Array.isArray(raw.tool_calls) || raw.tool_calls.length > 128) throw new ProtocolError("invalid-command", "assistant tool_calls must be an array");
      const ids = raw.tool_calls.map(validateToolCall);
      if (new Set(ids).size !== ids.length) throw new ProtocolError("invalid-command", "assistant tool call ids must be unique");
    }
  } else if (role === "tool") {
    exactKeys(raw, ["role", "content", "tool_call_id", "name"]);
    string(raw.tool_call_id, "tool_call_id", 128);
    string(raw.name, "tool name", 128);
  } else {
    throw new ProtocolError("invalid-command", `unsupported message role ${role}`);
  }
  return role as HostMessage["role"];
}

function validateTool(value: unknown): string {
  const raw = object(value, "tool");
  exactKeys(raw, ["type", "function"]);
  if (raw.type !== "function") throw new ProtocolError("invalid-command", "tool type must be function");
  const fn = object(raw.function, "tool function");
  exactKeys(fn, ["name", "description", "parameters"]);
  string(fn.name, "tool name", 128);
  text(fn.description, "tool description");
  object(fn.parameters, "tool parameters");
  return fn.name as string;
}

function validateLlmResponse(value: unknown): void {
  const raw = object(value, "LLM response");
  exactKeys(raw, ["message", "reasoning", "finish_reason"]);
  if (validateMessage(raw.message) !== "assistant") throw new ProtocolError("invalid-command", "LLM response message must be assistant");
  optionalText(raw.reasoning, "reasoning");
  const finishReason = string(raw.finish_reason, "finish_reason", 64);
  if (!["stop", "length", "tool_calls"].includes(finishReason)) throw new ProtocolError("invalid-command", `unsupported finish_reason ${finishReason}`);
  const message = raw.message as Record<string, unknown>;
  const hasToolCalls = Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
  if (finishReason === "tool_calls" && !hasToolCalls) throw new ProtocolError("invalid-command", "tool_calls finish_reason requires tool calls");
  if (finishReason === "stop" && hasToolCalls) throw new ProtocolError("invalid-command", "tool calls require tool_calls or length finish_reason");
}

export function requestIdHint(value: unknown): string {
  if (typeof value === "object" && value !== null && "request_id" in value && typeof value.request_id === "string") return value.request_id.slice(0, 128);
  return "unknown";
}

export function parseCommand(value: unknown): HostCommand {
  const raw = object(value, "command");
  const command = string(raw.command, "command", 64);
  const common = ["command", "request_id"];
  string(raw.request_id, "request_id", 128);
  if (command === "agent-run") {
    exactKeys(raw, [...common, "system_prompt", "messages", "tools", "model", "reasoning", "max_turns"]);
    if (!Array.isArray(raw.messages) || !Array.isArray(raw.tools)) throw new ProtocolError("invalid-command", "messages and tools must be arrays");
    if (raw.messages.length === 0 || raw.messages.length > 1_024 || raw.tools.length > 256) throw new ProtocolError("invalid-command", "messages or tools have invalid length");
    const roles = raw.messages.map(validateMessage);
    const lastConversationRole = [...roles].reverse().find((role) => role !== "system");
    if (lastConversationRole !== "user" && lastConversationRole !== "tool") throw new ProtocolError("invalid-command", "messages must end with a user or tool message");
    const toolNames = raw.tools.map(validateTool);
    if (new Set(toolNames).size !== toolNames.length) throw new ProtocolError("invalid-command", "tool names must be unique");
    optionalText(raw.system_prompt, "system_prompt");
    if (raw.model !== undefined) string(raw.model, "model");
    optionalText(raw.reasoning, "reasoning");
    if (!Number.isInteger(raw.max_turns) || Number(raw.max_turns) < 1 || Number(raw.max_turns) > 10) throw new ProtocolError("invalid-command", "max_turns must be between 1 and 10");
  } else if (command === "tool-result") {
    exactKeys(raw, [...common, "target_request_id", "tool_call_id", "outcome", "content"]);
    string(raw.target_request_id, "target_request_id", 128);
    string(raw.tool_call_id, "tool_call_id", 128);
    if (typeof raw.outcome !== "string" || !["completed", "refused", "failed"].includes(raw.outcome)) throw new ProtocolError("invalid-command", "invalid tool outcome");
    text(raw.content, "tool result content");
  } else if (command === "llm-completed") {
    exactKeys(raw, [...common, "call_id", "response"]);
    string(raw.call_id, "call_id", 128);
    validateLlmResponse(raw.response);
  } else if (command === "llm-failed") {
    exactKeys(raw, [...common, "call_id", "message"]);
    string(raw.call_id, "call_id", 128);
    string(raw.message, "failure message");
  } else if (command === "cancel") {
    exactKeys(raw, [...common, "target_request_id"]);
    string(raw.target_request_id, "target_request_id", 128);
  } else if (command === "shutdown") {
    exactKeys(raw, common);
  } else {
    throw new ProtocolError("invalid-command", `unsupported command ${command}`);
  }
  return raw as HostCommand;
}
