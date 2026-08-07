import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import { encodeEvent, MAX_OUTPUT_LINE_BYTES, readBoundedLines } from "../src/runner.ts";

test("bounded line reader handles chunked LF and CRLF input", async () => {
  const lines: string[] = [];
  for await (const line of readBoundedLines(Readable.from([Buffer.from("one\r"), Buffer.from("\ntwo\nlast")]))) lines.push(line);
  assert.deepEqual(lines, ["one", "two", "last"]);
});

test("bounded line reader rejects oversized commands", async () => {
  await assert.rejects(async () => {
    for await (const _line of readBoundedLines(Readable.from(["12345"]), 4)) {
      // The iterator must reject before yielding an oversized line.
    }
  }, /exceeds 4 bytes/);
});

test("event encoder reserves space for the NDJSON newline", () => {
  assert.equal(encodeEvent({ type: "ready", protocol_version: 1 }), '{"type":"ready","protocol_version":1}\n');
  assert.throws(
    () => encodeEvent({ type: "failed", request_id: "r", code: "large", message: "x".repeat(MAX_OUTPUT_LINE_BYTES) }),
    /exceeds 2 MiB/,
  );
});
