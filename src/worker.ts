import { clearAmbientEnvironment, assertSupportedRuntime } from "./runtime.ts";

assertSupportedRuntime();
clearAmbientEnvironment();
// ESM static imports execute before the module body. Load provider/agent code
// only after removing ambient credentials, including in the bundled worker.
const { runAgent } = await import("./agent-service.ts");
const { runWorker } = await import("./runner.ts");
await runWorker(runAgent);
