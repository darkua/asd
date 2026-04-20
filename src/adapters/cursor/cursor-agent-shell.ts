import { spawn, spawnSync, type ChildProcess, type StdioOptions } from "node:child_process";
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Same shell snippet as the worker: `agent -p -f --trust "$(cat "$CURSOR_PROMPT_FILE")"`. */
export const CURSOR_AGENT_SHELL_SCRIPT =
  'if [ -n "$CURSOR_AGENT_MODEL" ]; then "$CURSOR_AGENT_BIN" -p -f --trust --model "$CURSOR_AGENT_MODEL" "$(cat "$CURSOR_PROMPT_FILE")"; else "$CURSOR_AGENT_BIN" -p -f --trust "$(cat "$CURSOR_PROMPT_FILE")"; fi';

export interface CursorAgentShellEnvOptions {
  command: string;
  model?: string;
  promptFile: string;
  inheritFullEnv: boolean;
  pathPrepend?: string;
}

/**
 * Minimal env (no full inherit): common keys + every `CURSOR_*` var from the worker process.
 */
export function buildRestrictedChildEnv(): NodeJS.ProcessEnv {
  const ALLOWED_ENV_KEYS = [
    "HOME", "PATH", "SHELL", "USER", "LOGNAME",
    "LANG", "LC_ALL", "LC_CTYPE",
    "TERM", "TERM_PROGRAM",
    "NODE_ENV", "NODE_OPTIONS",
    "GH_TOKEN", "GITHUB_TOKEN",
    "SSH_AUTH_SOCK", "SSH_AGENT_PID",
    "TMPDIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_RUNTIME_DIR",
    "NO_OPEN_BROWSER",
  ];

  const env: NodeJS.ProcessEnv = {};
  for (const key of ALLOWED_ENV_KEYS) {
    const v = process.env[key];
    if (v !== undefined) {
      env[key] = v;
    }
  }
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (k.toUpperCase().startsWith("CURSOR")) {
      env[k] = v;
    }
  }
  return env;
}

/** Resolve `command -v` for the agent binary under the same env the child will use. */
export function resolveAgentBinaryInEnv(command: string, env: NodeJS.ProcessEnv): string {
  const q = `'${String(command).replace(/'/g, `'\\''`)}'`;
  try {
    const r = spawnSync("/bin/sh", ["-c", `command -v ${q}`], {
      env,
      encoding: "utf-8",
      timeout: 15000,
    });

    if (r.error) {
      const code = (r.error as NodeJS.ErrnoException).code ?? "UNKNOWN";
      return `(resolve failed: ${code})`;
    }

    const line = (r.stdout ?? "").trim().split("\n")[0];
    return line || "(not found)";
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return `(resolve failed: ${msg})`;
  }
}

/** Child env: restricted or full inherit + optional PATH prepend + spawn-only vars. */
export function buildCursorAgentSpawnEnv(opts: CursorAgentShellEnvOptions): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};

  if (opts.inheritFullEnv) {
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined) {
        env[k] = v;
      }
    }
  } else {
    Object.assign(env, buildRestrictedChildEnv());
  }

  if (opts.pathPrepend) {
    const cur = env.PATH ?? "";
    env.PATH = cur ? `${opts.pathPrepend}:${cur}` : opts.pathPrepend;
  }

  env.CURSOR_AGENT_BIN = opts.command;
  if (opts.model) {
    env.CURSOR_AGENT_MODEL = opts.model;
  }
  env.CURSOR_PROMPT_FILE = opts.promptFile;
  return env;
}

/** Write prompt text to a temp file (same pattern as worker + debug CLI). */
export function writeCursorAgentPromptFile(promptText: string, runId: string): string {
  const safeId = runId.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 40);
  const promptPath = join(tmpdir(), `mowafaqa-cursor-${safeId}-${randomBytes(8).toString("hex")}.txt`);
  writeFileSync(promptPath, promptText, "utf8");
  return promptPath;
}

export interface SpawnCursorAgentShellParams {
  workDir: string;
  promptPath: string;
  command: string;
  model?: string;
  inheritFullEnv: boolean;
  pathPrepend?: string;
  timeoutMs: number;
  detached: boolean;
  /** When true, stdio is inherited (TTY when available). When false, stdin ignored and stdout/stderr piped. */
  stdioInherit: boolean;
}

/**
 * Single spawn used by the JIRA worker (`CursorAgentProvider`) and `scripts/debug-cursor-agent.ts`.
 */
export function spawnCursorAgentShell(p: SpawnCursorAgentShellParams): ChildProcess {
  const childEnv = buildCursorAgentSpawnEnv({
    command: p.command,
    model: p.model,
    promptFile: p.promptPath,
    inheritFullEnv: p.inheritFullEnv,
    pathPrepend: p.pathPrepend,
  });
  const stdio: StdioOptions = p.stdioInherit ? "inherit" : ["ignore", "pipe", "pipe"];
  return spawn("/bin/sh", ["-c", CURSOR_AGENT_SHELL_SCRIPT], {
    cwd: p.workDir,
    detached: p.detached,
    stdio,
    timeout: p.timeoutMs,
    env: childEnv,
  });
}
