export function assertSupportedRuntime(version = process.versions.node): void {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match || Number(match[1]) !== 22 || Number(match[2]) < 19) {
    throw new Error("kestral-pi worker requires Node.js >=22.19 and <23");
  }
}

export function clearAmbientEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
  platform = process.platform,
): void {
  for (const name of Object.keys(environment)) {
    const windowsRuntime = platform === "win32" && ["systemroot", "windir"].includes(name.toLowerCase());
    if (!windowsRuntime) delete environment[name];
  }
}
