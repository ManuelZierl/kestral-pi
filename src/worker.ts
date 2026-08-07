import { clearAmbientEnvironment, assertSupportedRuntime } from "./runtime.ts";
import { runWorker } from "./runner.ts";

assertSupportedRuntime();
clearAmbientEnvironment();
await runWorker();
