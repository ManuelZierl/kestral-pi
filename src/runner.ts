import type { Readable } from "node:stream";
import { runAgent, type AgentHostBridge, type Emit } from "./agent-service.ts";
import { parseCommand, PROTOCOL_VERSION, ProtocolError, requestIdHint, type HostCommand, type HostLlmResponse } from "./protocol.ts";

export const MAX_INPUT_LINE_BYTES = 4 * 1024 * 1024;
export const MAX_OUTPUT_LINE_BYTES = 2 * 1024 * 1024;

type Pending = { resolve(value: unknown): void; reject(error: Error): void };

const modelCallKey = (callId: string): string => JSON.stringify(["model", callId]);
const toolCallKey = (requestId: string, toolCallId: string): string => JSON.stringify(["tool", requestId, toolCallId]);

export async function* readBoundedLines(input: Readable, maximum = MAX_INPUT_LINE_BYTES): AsyncGenerator<string> {
  let chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of input) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let offset = 0;
    while (offset < bytes.length) {
      const newline = bytes.indexOf(0x0a, offset);
      const end = newline === -1 ? bytes.length : newline;
      const part = bytes.subarray(offset, end);
      chunks.push(part);
      length += part.length;
      if (length > maximum) throw new ProtocolError("payload-too-large", `command line exceeds ${maximum} bytes`);
      if (newline === -1) break;
      let line = Buffer.concat(chunks, length);
      if (line.at(-1) === 0x0d) line = line.subarray(0, -1);
      yield line.toString("utf8");
      chunks = [];
      length = 0;
      offset = newline + 1;
    }
  }
  if (length > 0) {
    let line = Buffer.concat(chunks, length);
    if (line.at(-1) === 0x0d) line = line.subarray(0, -1);
    yield line.toString("utf8");
  }
}

export function encodeEvent(event: Parameters<Emit>[0]): string {
  const encoded = `${JSON.stringify(event)}\n`;
  if (Buffer.byteLength(encoded) > MAX_OUTPUT_LINE_BYTES) throw new ProtocolError("payload-too-large", "worker event exceeds 2 MiB");
  return encoded;
}

export async function runWorker(): Promise<void> {
  const emit: Emit = (event) => process.stdout.write(encodeEvent(event));
  const input = process.stdin;
  const pending = new Map<string, Pending>();
  const jobs = new Map<string, AbortController>();
  const tasks = new Set<Promise<void>>();
  const wait = <T>(key: string, signal: AbortSignal) => new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("request cancelled"));
      return;
    }
    if (pending.has(key)) {
      reject(new Error("callback id is already pending"));
      return;
    }
    const cleanup = () => {
      pending.delete(key);
      signal.removeEventListener("abort", abort);
    };
    const abort = () => { cleanup(); reject(new Error("request cancelled")); };
    signal.addEventListener("abort", abort, { once: true });
    pending.set(key, {
      resolve: (value) => { cleanup(); resolve(value as T); },
      reject: (error) => { cleanup(); reject(error); },
    });
  });
  const request = <T>(key: string, signal: AbortSignal, event: Parameters<Emit>[0]): Promise<T> => {
    if (pending.has(key)) return Promise.reject(new Error("callback id is already pending"));
    const response = wait<T>(key, signal);
    try {
      emit(event);
    } catch (error) {
      pending.get(key)?.reject(error instanceof Error ? error : new Error("failed to emit worker request"));
    }
    return response;
  };
  const bridge: AgentHostBridge = {
    generate: async (requestId, model, messages, tools, reasoning, signal) => {
      const callId = crypto.randomUUID();
      return request<HostLlmResponse>(
        modelCallKey(callId),
        signal,
        { type: "llm-request", request_id: requestId, call_id: callId, model, messages, tools, ...(reasoning ? { reasoning } : {}) },
      );
    },
    invokeTool: async (requestId, toolCallId, toolName, args, signal) => {
      return request(
        toolCallKey(requestId, toolCallId),
        signal,
        { type: "tool-request", request_id: requestId, tool_call_id: toolCallId, tool_name: toolName, arguments: args },
      );
    },
  };
  emit({ type: "ready", protocol_version: PROTOCOL_VERSION });
  try {
    for await (const line of readBoundedLines(input)) {
      if (!line.trim()) continue;
      let raw: unknown;
      try {
        raw = JSON.parse(line);
        const command: HostCommand = parseCommand(raw);
        if (command.command === "agent-run") {
          if (jobs.has(command.request_id)) throw new ProtocolError("duplicate-request", "request is already active");
          const controller = new AbortController();
          jobs.set(command.request_id, controller);
          const task = runAgent(command, bridge, emit, controller.signal)
            .catch((error) => emit({ type: "failed", request_id: command.request_id, code: "agent-failed", message: error instanceof Error ? error.message : "agent failed" }))
            .finally(() => jobs.delete(command.request_id));
          tasks.add(task);
          void task.then(() => tasks.delete(task), () => tasks.delete(task));
        } else if (command.command === "llm-completed" || command.command === "llm-failed") {
          const waiter = pending.get(modelCallKey(command.call_id));
          if (!waiter) throw new ProtocolError("unknown-request", "unknown model call");
          command.command === "llm-completed" ? waiter.resolve(command.response) : waiter.reject(new Error(command.message));
        } else if (command.command === "tool-result") {
          const waiter = pending.get(toolCallKey(command.target_request_id, command.tool_call_id));
          if (!waiter) throw new ProtocolError("unknown-request", "unknown tool call");
          waiter.resolve({ outcome: command.outcome, content: command.content });
        } else if (command.command === "cancel") {
          jobs.get(command.target_request_id)?.abort();
          emit({ type: "acknowledged", request_id: command.request_id, command: "cancel", target_request_id: command.target_request_id });
        } else if (command.command === "shutdown") {
          for (const controller of jobs.values()) controller.abort();
          await Promise.allSettled(tasks);
          emit({ type: "acknowledged", request_id: command.request_id, command: "shutdown" });
          input.destroy();
          break;
        }
      } catch (error) {
        emit({ type: "failed", request_id: requestIdHint(raw), code: error instanceof ProtocolError ? error.code : "invalid-json", message: error instanceof Error ? error.message : "invalid input" });
      }
    }
  } catch (error) {
    emit({ type: "failed", request_id: "unknown", code: error instanceof ProtocolError ? error.code : "input-failed", message: error instanceof Error ? error.message : "input failed" });
    input.destroy();
  } finally {
    for (const controller of jobs.values()) controller.abort();
    await Promise.allSettled(tasks);
  }
}
