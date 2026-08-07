import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import test from "node:test";

async function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), 5_000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function startWorker() {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const child = spawn(process.execPath, [join(root, "dist", "backend", "worker.mjs")], { stdio: ["pipe", "pipe", "pipe"] });
  const lines = createInterface({ input: child.stdout });
  const iterator = lines[Symbol.asyncIterator]();
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  return {
    child,
    send(command: unknown) {
      child.stdin.write(`${JSON.stringify(command)}\n`);
    },
    async next(): Promise<any> {
      const item = await withTimeout(iterator.next(), "worker output");
      if (item.done) throw new Error(`worker closed stdout: ${stderr}`);
      return JSON.parse(item.value);
    },
    async nextWhere(predicate: (event: any) => boolean): Promise<any> {
      while (true) {
        const event = await this.next();
        if (predicate(event)) return event;
      }
    },
    async shutdown() {
      this.send({ command: "shutdown", request_id: "shutdown" });
      const acknowledged = await this.nextWhere((event) => event.type === "acknowledged" && event.command === "shutdown");
      assert.equal(acknowledged.request_id, "shutdown");
      child.stdin.end();
      await withTimeout(
        new Promise<void>((resolve, reject) => {
          child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`worker exited ${code}: ${stderr}`)));
          child.once("error", reject);
        }),
        "worker exit",
      );
    },
  };
}

test("built worker completes a correlated model round trip", async () => {
  const worker = startWorker();
  try {
    const ready = await worker.next();
    assert.deepEqual(ready, { type: "ready", protocol_version: 1 });
    worker.send({ command: "agent-run", request_id: "run-1", messages: [{ role: "user", content: "hello" }], tools: [], max_turns: 2 });
    const request = await worker.nextWhere((event) => event.type === "llm-request");
    worker.send({ command: "llm-completed", request_id: "reply-1", call_id: request.call_id, response: { message: { role: "assistant", content: "hello back" }, finish_reason: "stop" } });
    const completed = await worker.nextWhere((event) => event.type === "completed");
    assert.equal(completed.text, "hello back");

    worker.send({ command: "agent-run", request_id: "run-cancel", messages: [{ role: "user", content: "wait" }], tools: [], max_turns: 2 });
    worker.send({ command: "cancel", request_id: "cancel-1", target_request_id: "run-cancel" });
    await worker.nextWhere((event) => event.type === "failed" && event.request_id === "run-cancel" && event.code === "cancelled");
    await worker.shutdown();
  } finally {
    if (worker.child.exitCode === null) worker.child.kill();
  }
});

test("tool results are correlated by job when tool call ids collide", async () => {
  const worker = startWorker();
  const tool = { type: "function", function: { name: "read", description: "Read", parameters: { type: "object", properties: {}, additionalProperties: false } } };
  try {
    assert.deepEqual(await worker.next(), { type: "ready", protocol_version: 1 });
    worker.send({ command: "agent-run", request_id: "run-a", messages: [{ role: "user", content: "a" }], tools: [tool], max_turns: 2 });
    worker.send({ command: "agent-run", request_id: "run-b", messages: [{ role: "user", content: "b" }], tools: [tool], max_turns: 2 });

    const modelRequests = new Map<string, any>();
    while (modelRequests.size < 2) {
      const event = await worker.next();
      if (event.type === "llm-request") modelRequests.set(event.request_id, event);
    }
    for (const [requestId, request] of modelRequests) {
      worker.send({
        command: "llm-completed",
        request_id: `reply-${requestId}`,
        call_id: request.call_id,
        response: { message: { role: "assistant", content: "", tool_calls: [{ id: "shared", type: "function", function: { name: "read", arguments: "{}" } }] }, finish_reason: "tool_calls" },
      });
    }

    const toolRequests = new Map<string, any>();
    while (toolRequests.size < 2) {
      const event = await worker.next();
      if (event.type === "tool-request") toolRequests.set(event.request_id, event);
    }
    assert.deepEqual([...toolRequests.values()].map((event) => event.tool_call_id), ["shared", "shared"]);
    worker.send({ command: "tool-result", request_id: "tool-reply-a", target_request_id: "run-a", tool_call_id: "shared", outcome: "completed", content: "result-a" });
    worker.send({ command: "tool-result", request_id: "tool-reply-b", target_request_id: "run-b", tool_call_id: "shared", outcome: "completed", content: "result-b" });

    const followUps = new Map<string, any>();
    while (followUps.size < 2) {
      const event = await worker.next();
      if (event.type === "llm-request") followUps.set(event.request_id, event);
    }
    assert.equal(followUps.get("run-a").messages.findLast((message: any) => message.role === "tool").content, "result-a");
    assert.equal(followUps.get("run-b").messages.findLast((message: any) => message.role === "tool").content, "result-b");
    for (const [requestId, request] of followUps) {
      worker.send({ command: "llm-completed", request_id: `final-${requestId}`, call_id: request.call_id, response: { message: { role: "assistant", content: `done-${requestId}` }, finish_reason: "stop" } });
    }
    const completed = new Set<string>();
    while (completed.size < 2) {
      const event = await worker.next();
      if (event.type === "completed") completed.add(event.request_id);
    }
    assert.deepEqual(completed, new Set(["run-a", "run-b"]));
    await worker.shutdown();
  } finally {
    if (worker.child.exitCode === null) worker.child.kill();
  }
});
