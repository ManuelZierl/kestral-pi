import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Readable } from "node:stream";
import test, { type TestContext } from "node:test";
import { MAX_ACTIVE_JOBS, MAX_OUTPUT_LINE_BYTES, readBoundedLines, runWorker, type AgentRunner } from "../src/runner.ts";
import type { WorkerEvent } from "../src/protocol.ts";

function harness(t: TestContext, run: AgentRunner) {
  const input = new PassThrough();
  const output = new PassThrough();
  const emitted = new EventEmitter();
  const events: WorkerEvent[] = [];
  let buffered = "";
  output.setEncoding("utf8");
  output.on("data", (chunk: string) => {
    buffered += chunk;
    let end: number;
    while ((end = buffered.indexOf("\n")) >= 0) {
      const event = JSON.parse(buffered.slice(0, end)) as WorkerEvent;
      buffered = buffered.slice(end + 1);
      events.push(event);
      emitted.emit("event", event);
    }
  });
  const done = runWorker(run, input, output);
  t.after(async () => { input.end(); await done; output.destroy(); });
  return {
    input, done, events,
    send(value: unknown) { input.write(`${JSON.stringify(value)}\n`); },
    start(id: string) { this.send({ command: "agent-run", request_id: id, messages: [{ role: "user", content: "hello" }], tools: [], max_turns: 2 }); },
    async next(predicate: (event: WorkerEvent) => boolean): Promise<WorkerEvent> {
      const found = events.find(predicate);
      if (found) return found;
      return new Promise((resolve, reject) => {
        const cleanup = () => { clearTimeout(timer); emitted.removeListener("event", receive); };
        const receive = (event: WorkerEvent) => { if (predicate(event)) { cleanup(); resolve(event); } };
        const timer = setTimeout(() => { cleanup(); reject(new Error("worker event timed out")); }, 2_000);
        emitted.on("event", receive);
      });
    },
  };
}

const modelRunner: AgentRunner = async (command, bridge, emit, signal) => {
  const result = await bridge.generate(command.request_id, "default", command.messages, [], undefined, signal);
  emit({ type: "completed", request_id: command.request_id, text: result.message.content, finish_reason: "stop", turns: 1, transcript: command.messages });
};

for (const kind of ["model", "tool"] as const) {
  test(`malformed ${kind} callbacks fail their owning job exactly once`, async (t) => {
    let toolReturned = false;
    const worker = harness(t, kind === "model" ? modelRunner : async (command, bridge, emit, signal) => {
      await bridge.invokeTool(command.request_id, "tool-1", "read", {}, signal);
      toolReturned = true;
      emit({ type: "completed", request_id: command.request_id, text: "must not complete", finish_reason: "stop", turns: 1, transcript: [] });
    });
    worker.start("owner");
    const request = await worker.next((event) => event.type === (kind === "model" ? "llm-request" : "tool-request"));
    if (request.type === "llm-request") {
      worker.send({ command: "llm-completed", request_id: "different-callback-id", call_id: request.call_id, response: { message: { role: "user", content: "wrong role" }, finish_reason: "stop" } });
    } else {
      worker.send({ command: "tool-result", request_id: "different-callback-id", target_request_id: "owner", tool_call_id: "tool-1", outcome: "not-valid", content: "bad" });
    }
    const failure = await worker.next((event) => event.type === "failed");
    assert.equal(failure.type === "failed" && failure.request_id, "owner");
    assert.equal(failure.type === "failed" && failure.code, "invalid-command");
    worker.input.end();
    await worker.done;
    assert.equal(worker.events.filter((event) => event.type === "failed" || event.type === "completed").length, 1);
    assert.equal(toolReturned, false);
  });
}

test("invalid callbacks do not cancel unrelated jobs", async (t) => {
  const worker = harness(t, modelRunner);
  worker.start("bad"); worker.start("healthy");
  const bad = await worker.next((event) => event.type === "llm-request" && event.request_id === "bad");
  const healthy = await worker.next((event) => event.type === "llm-request" && event.request_id === "healthy");
  assert.equal(bad.type, "llm-request"); assert.equal(healthy.type, "llm-request");
  if (bad.type !== "llm-request" || healthy.type !== "llm-request") return;
  worker.send({ command: "llm-failed", request_id: "bad-reply", call_id: bad.call_id, message: 123 });
  await worker.next((event) => event.type === "failed" && event.request_id === "bad");
  worker.send({ command: "llm-completed", request_id: "healthy-reply", call_id: healthy.call_id, response: { message: { role: "assistant", content: "healthy answer" }, finish_reason: "stop" } });
  const result = await worker.next((event) => event.type === "completed" && event.request_id === "healthy");
  assert.equal(result.type === "completed" && result.text, "healthy answer");
});

test("already aborted callback requests emit no model or tool work", async (t) => {
  let checked = false;
  const worker = harness(t, async (command, bridge, emit) => {
    const controller = new AbortController(); controller.abort();
    await assert.rejects(bridge.generate(command.request_id, "default", command.messages, [], undefined, controller.signal), /cancelled/);
    await assert.rejects(bridge.invokeTool(command.request_id, "t", "read", {}, controller.signal), /cancelled/);
    checked = true;
    emit({ type: "failed", request_id: command.request_id, code: "cancelled", message: "cancelled" });
  });
  worker.start("cancelled");
  await worker.next((event) => event.type === "failed");
  assert.equal(checked, true);
  assert.equal(worker.events.some((event) => event.type === "llm-request" || event.type === "tool-request"), false);
});

test("duplicate active IDs produce one terminal failure and abort the original wait", async (t) => {
  const worker = harness(t, modelRunner);
  worker.start("duplicate");
  await worker.next((event) => event.type === "llm-request");
  worker.start("duplicate");
  const result = await worker.next((event) => event.type === "failed");
  assert.equal(result.type === "failed" && result.code, "duplicate-request");
  worker.input.end(); await worker.done;
  assert.equal(worker.events.filter((event) => event.type === "failed" || event.type === "completed").length, 1);
});

test("huge validation errors are bounded and leave the worker usable", async (t) => {
  const worker = harness(t, modelRunner);
  worker.send({ command: "shutdown", request_id: "bad", ["x".repeat(MAX_OUTPUT_LINE_BYTES)]: true });
  const error = await worker.next((event) => event.type === "failed" && event.request_id === "bad");
  assert.equal(error.type === "failed" && error.code, "invalid-command");
  assert.ok(error.type === "failed" && error.message.length <= 16_384);
  assert.match(error.type === "failed" ? error.message : "", /truncated/);
  worker.start("still-alive");
  await worker.next((event) => event.type === "llm-request" && event.request_id === "still-alive");
});

test("oversized outgoing callbacks reject and release their pending wait", async (t) => {
  const worker = harness(t, async (command, bridge, _emit, signal) => {
    await bridge.generate(command.request_id, "default", [{ role: "user", content: "x".repeat(MAX_OUTPUT_LINE_BYTES) }], [], undefined, signal);
  });
  worker.start("large");
  const failure = await worker.next((event) => event.type === "failed");
  assert.equal(failure.type === "failed" && failure.code, "payload-too-large");
  assert.equal(worker.events.some((event) => event.type === "llm-request"), false);
});

test("EOF cancels outstanding callbacks without leaving active tasks", async (t) => {
  const worker = harness(t, modelRunner);
  worker.start("eof");
  await worker.next((event) => event.type === "llm-request");
  worker.input.end(); await worker.done;
  assert.equal(worker.events.filter((event) => event.type === "failed").length, 1);
});

test("worker bounds concurrent jobs and remains responsive to shutdown", async (t) => {
  const worker = harness(t, modelRunner);
  for (let index = 0; index <= MAX_ACTIVE_JOBS; index += 1) worker.start(`job-${index}`);
  const failure = await worker.next((event) => event.type === "failed");
  assert.equal(failure.type === "failed" && failure.code, "worker-busy");
  assert.equal(failure.type === "failed" && failure.request_id, `job-${MAX_ACTIVE_JOBS}`);
  worker.send({ command: "shutdown", request_id: "shutdown" });
  await worker.next((event) => event.type === "acknowledged" && event.command === "shutdown");
  await worker.done;
});

test("line reader rejects invalid UTF-8 instead of changing input", async () => {
  await assert.rejects(async () => {
    for await (const _ of readBoundedLines(Readable.from([Buffer.from([0xc3, 0x28, 0x0a])]))) { /* must reject */ }
  }, /valid UTF-8/);
  const lines: string[] = [];
  for await (const line of readBoundedLines(Readable.from([Buffer.from([0xe2]), Buffer.from([0x82, 0xac, 0x0a])]))) lines.push(line);
  assert.deepEqual(lines, ["€"]);
});

test("synchronous runner exceptions are contained", async (t) => {
  const worker = harness(t, () => { throw new Error("synchronous failure"); });
  worker.start("sync");
  const failure = await worker.next((event) => event.type === "failed");
  assert.equal(failure.type === "failed" && failure.message, "synchronous failure");
});
