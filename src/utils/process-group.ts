import { KILL_GRACE_MS, KILL_POLL_INTERVAL_MS } from "../constants.js";

/**
 * Send SIGTERM to a detached process group, then SIGKILL after grace period.
 */
export async function killProcessGroup(pid: number, log: { debug: (m: string) => void; info: (m: string) => void }): Promise<void> {
  try {
    process.kill(-pid, 0);
  } catch {
    log.debug(`Process group ${pid} already dead`);
    return;
  }

  log.info(`Killing process group ${pid}`);

  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    return;
  }

  await new Promise<void>((resolve) => {
    const checkInterval = setInterval(() => {
      try {
        process.kill(-pid, 0);
      } catch {
        clearInterval(checkInterval);
        resolve();
      }
    }, KILL_POLL_INTERVAL_MS);

    setTimeout(() => {
      clearInterval(checkInterval);
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // already dead
      }
      resolve();
    }, KILL_GRACE_MS);
  });

  log.info(`Process group ${pid} terminated`);
}
