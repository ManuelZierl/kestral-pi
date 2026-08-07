import assert from "node:assert/strict";
import test from "node:test";
import { assertSupportedRuntime, clearAmbientEnvironment } from "../src/runtime.ts";

test("runtime accepts supported Node 22 releases only", () => {
  assert.doesNotThrow(() => assertSupportedRuntime("22.19.0"));
  assert.doesNotThrow(() => assertSupportedRuntime("22.20.1"));
  assert.throws(() => assertSupportedRuntime("22.18.0"), />=22\.19 and <23/);
  assert.throws(() => assertSupportedRuntime("23.0.0"), />=22\.19 and <23/);
  assert.throws(() => assertSupportedRuntime("invalid"), />=22\.19 and <23/);
});

test("ambient environment clearing preserves only Windows runtime paths", () => {
  const linux = { HOME: "/home/user", API_KEY: "secret" };
  clearAmbientEnvironment(linux, "linux");
  assert.deepEqual(linux, {});

  const windows = { SystemRoot: "C:\\Windows", WINDIR: "C:\\Windows", API_KEY: "secret" };
  clearAmbientEnvironment(windows, "win32");
  assert.deepEqual(windows, { SystemRoot: "C:\\Windows", WINDIR: "C:\\Windows" });
});
