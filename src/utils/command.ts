import { spawn } from "child_process";

export async function executeCommand(
  command: string,
  args: string[],
  cwd: string,
  logPrefix: string,
  envOverride?: NodeJS.ProcessEnv,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const env = envOverride ? { ...process.env, ...envOverride } : process.env;
    const proc = spawn(command, args, { cwd, env });

    proc.stdout.on("data", (data) => {
      const logLine = data.toString().trim();
      if (logLine) {
        console.log(`[${logPrefix}]: ${logLine}`);
        // TODO: Emit to Redis/WebSocket for real-time frontend view
      }
    });

    proc.stderr.on("data", (data) => {
      const logLine = data.toString().trim();
      if (logLine) {
        console.log(`[${logPrefix}]: ${logLine}`);
        // TODO: Emit to Redis/WebSocket for real-time frontend view
      }
    });

    proc.on("close", (code) => {
      if (code === 0) {
        console.log(`[${logPrefix}] Completed successfully.`);
        resolve();
      } else {
        reject(new Error(`[${logPrefix}] Failed with exit code ${code}`));
      }
    });

    proc.on("error", (err) => {
      reject(new Error(`[${logPrefix}] Process error: ${err.message}`));
    });
  });
}
