import type { Readable, Writable } from "node:stream";
import type { runAgent, AgentHostBridge, Emit } from "./agent-service.ts";
import { parseCommand, PROTOCOL_VERSION, ProtocolError, requestIdHint, type HostCommand, type HostLlmResponse } from "./protocol.ts";

export const MAX_INPUT_LINE_BYTES = 4 * 1024 * 1024;
export const MAX_OUTPUT_LINE_BYTES = 2 * 1024 * 1024;
export const MAX_ACTIVE_JOBS = 32;

export type AgentRunner = typeof runAgent;
type Pending = { requestId: string; resolve(value: unknown): void; reject(error: Error): void };
type Job = { controller: AbortController; fail(error: Error): void };

const modelCallKey = (callId: string): string => JSON.stringify(["model", callId]);
const toolCallKey = (requestId: string, toolCallId: string): string => JSON.stringify(["tool", requestId, toolCallId]);

function decodeLine(bytes: Buffer): string {
  if (bytes.at(-1) === 0x0d) bytes = bytes.subarray(0, -1);
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new ProtocolError("invalid-encoding", "command line must be valid UTF-8");
  }
}

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
      yield decodeLine(Buffer.concat(chunks, length));
      chunks = [];
      length = 0;
      offset = newline + 1;
    }
  }
  if (length > 0) yield decodeLine(Buffer.concat(chunks, length));
}

export function encodeEvent(event: Parameters<Emit>[0]): string {
  const encoded = `${JSON.stringify(event)}\n`;
  if (Buffer.byteLength(encoded) > MAX_OUTPUT_LINE_BYTES) throw new ProtocolError("payload-too-large", "worker event exceeds 2 MiB");
  return encoded;
}

export async function runWorker(run: AgentRunner, input: Readable = process.stdin, output: Writable = process.stdout): Promise<void> {
  const emit: Emit = (event) => {
    // Error text can contain an entire invalid JSON field. Reporting a rejected
    // payload must not itself exceed the wire limit and crash the worker.
    if (event.type === "failed" && event.message.length > 16_384) {
      event = { ...event, message: `${event.message.slice(0, 16_360)}... [truncated]` };
    }
    output.write(encodeEvent(event));
  };
  const pending = new Map<string, Pending>();
  const jobs = new Map<string, Job>();
  const tasks = new Set<Promise<void>>();
  const wait = <T>(key: string, requestId: string, signal: AbortSignal) => new Promise<T>((resolve, reject) => {
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
      requestId,
      resolve: (value) => { cleanup(); resolve(value as T); },
      reject: (error) => { cleanup(); reject(error); },
    });
  });
  const request = <T>(key: string, requestId: string, signal: AbortSignal, event: Parameters<Emit>[0]): Promise<T> => {
    // Do not ask the host to perform work when no callback can be registered.
    if (signal.aborted) return Promise.reject(new Error("request cancelled"));
    if (pending.has(key)) return Promise.reject(new Error("callback id is already pending"));
    const response = wait<T>(key, requestId, signal);
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
        modelCallKey(callId), requestId, signal,
        { type: "llm-request", request_id: requestId, call_id: callId, model, messages, tools, ...(reasoning ? { reasoning } : {}) },
      );
    },
    invokeTool: async (requestId, toolCallId, toolName, args, signal) => request(
      toolCallKey(requestId, toolCallId), requestId, signal,
      { type: "tool-request", request_id: requestId, tool_call_id: toolCallId, tool_name: toolName, arguments: args },
    ),
  };
  const failCallback = (raw: unknown, error: Error): boolean => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return false;
    const value = raw as Record<string, unknown>;
    let key: string | undefined;
    if ((value.command === "llm-completed" || value.command === "llm-failed") && typeof value.call_id === "string") {
      key = modelCallKey(value.call_id);
    } else if (value.command === "tool-result" && typeof value.target_request_id === "string" && typeof value.tool_call_id === "string") {
      key = toolCallKey(value.target_request_id, value.tool_call_id);
    }
    const waiter = key === undefined ? undefined : pending.get(key);
    const job = waiter && jobs.get(waiter.requestId);
    if (!job) return false;
    // Callback command IDs are not necessarily the agent job ID. Fail the
    // owning job exactly once, and release its pending waits through abort.
    job.fail(error);
    return true;
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
          const existing = jobs.get(command.request_id);
          if (existing) {
            existing.fail(new ProtocolError("duplicate-request", "request is already active"));
            continue;
          }
          if (jobs.size >= MAX_ACTIVE_JOBS) throw new ProtocolError("worker-busy", "too many active agent requests");
          const controller = new AbortController();
          let ended = false;
          const emitJob: Emit = (event) => {
            if (ended) return;
            emit(event);
            if (event.type === "failed" || event.type === "completed") ended = true;
          };
          const job: Job = {
            controller,
            fail: (error) => {
              try {
                emitJob({ type: "failed", request_id: command.request_id, code: error instanceof ProtocolError ? error.code : "agent-failed", message: error.message });
              } finally {
                controller.abort();
              }
            },
          };
          jobs.set(command.request_id, job);
          // The promise boundary also contains synchronous runner failures.
          const task = Promise.resolve().then(() => run(command, bridge, emitJob, controller.signal))
            .catch((error) => job.fail(error instanceof Error ? error : new Error("agent failed")))
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
          jobs.get(command.target_request_id)?.controller.abort();
          emit({ type: "acknowledged", request_id: command.request_id, command: "cancel", target_request_id: command.target_request_id });
        } else if (command.command === "shutdown") {
          for (const job of jobs.values()) job.controller.abort();
          await Promise.allSettled(tasks);
          emit({ type: "acknowledged", request_id: command.request_id, command: "shutdown" });
          input.destroy();
          break;
        }
      } catch (error) {
        if (error instanceof ProtocolError && failCallback(raw, error)) continue;
        emit({ type: "failed", request_id: requestIdHint(raw), code: error instanceof ProtocolError ? error.code : "invalid-json", message: error instanceof Error ? error.message : "invalid input" });
      }
    }
  } catch (error) {
    emit({ type: "failed", request_id: "unknown", code: error instanceof ProtocolError ? error.code : "input-failed", message: error instanceof Error ? error.message : "input failed" });
    input.destroy();
  } finally {
    for (const job of jobs.values()) job.controller.abort();
    await Promise.allSettled(tasks);
  }
}
