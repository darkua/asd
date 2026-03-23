import { appendFileSync, statSync, renameSync, existsSync } from "node:fs";
import { config } from "./config/config.js";

function rotateIfNeeded(logFile: string): void {
  try {
    const stats = statSync(logFile);
    if (stats.size > 10 * 1024 * 1024) { // 10MB
      // Shift existing rotations
      for (let i = 2; i >= 1; i--) {
        const from = i === 1 ? logFile : `${logFile}.${i - 1}`;
        const to = `${logFile}.${i}`;
        if (existsSync(from)) {
          try { renameSync(from, to); } catch { /* ignore */ }
        }
      }
      // Rotate current
      try { renameSync(logFile, `${logFile}.1`); } catch { /* ignore */ }
    }
  } catch {
    // File doesn't exist yet, no rotation needed
  }
}

type LogLevel = "info" | "warn" | "error" | "debug";

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  jiraKey?: string;
  [key: string]: unknown;
}

function write(entry: LogEntry): void {
  const line = JSON.stringify(entry);

  const color: Record<LogLevel, string> = {
    info: "\x1b[36m",
    warn: "\x1b[33m",
    error: "\x1b[31m",
    debug: "\x1b[90m",
  };
  const reset = "\x1b[0m";
  const prefix = entry.jiraKey ? `[${entry.jiraKey}]` : "";

  console.log(
    `${color[entry.level]}${entry.level.toUpperCase().padEnd(5)}${reset} ${prefix} ${entry.message}`
  );

  if (config.paths.logFile) {
    rotateIfNeeded(config.paths.logFile);
    appendFileSync(config.paths.logFile, line + "\n");
  }
}

export function createLogger(jiraKey?: string) {
  function log(level: LogLevel, message: string, meta?: Record<string, unknown>) {
    write({
      timestamp: new Date().toISOString(),
      level,
      message,
      jiraKey,
      ...meta,
    });
  }

  return {
    info: (msg: string, meta?: Record<string, unknown>) => log("info", msg, meta),
    warn: (msg: string, meta?: Record<string, unknown>) => log("warn", msg, meta),
    error: (msg: string, meta?: Record<string, unknown>) => log("error", msg, meta),
    debug: (msg: string, meta?: Record<string, unknown>) => log("debug", msg, meta),
  };
}

export const logger = createLogger();
