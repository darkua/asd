/**
 * Debug Cursor CLI spawn — mirrors `CursorAgentProvider` (temp prompt file + `/bin/sh -c` + same env rules).
 *
 * Usage:
 *   npx tsx scripts/debug-cursor-agent.ts <workdir> <prompt-file>
 *   npm run cursor:debug -- /path/to/.worktrees/mp-571 ./prompt.txt
 *
 * Options (before positionals):
 *   --timeout-ms <n>     Wall-clock ms (default 600000 or AGENT_TIMEOUT_MS)
 *   --bin <name>         Overrides CURSOR_AGENT_BIN
 *   --path-prepend <p>   Prepended to child PATH (or use CURSOR_AGENT_PATH_PREPEND)
 *   --inherit-env        Sets full process.env for child (or set CURSOR_AGENT_INHERIT_ENV=true)
 *   --attached           spawn without detached (closer to interactive debugging)
 *   --stdio inherit      use stdio inherit instead of piping (TTY if your terminal has one)
 *
 * Loads `<repo>/.env` if present (for CURSOR_* without exporting in shell).
 */

import { config as loadDotenv } from "dotenv";
import { readFileSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildCursorAgentSpawnEnv,
  CURSOR_AGENT_SHELL_SCRIPT,
  resolveAgentBinaryInEnv,
  spawnCursorAgentShell,
  writeCursorAgentPromptFile,
} from "../src/adapters/cursor/cursor-agent-shell.js";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
loadDotenv({ path: join(repoRoot, ".env") });

function usage(exitCode: 0 | 1 = 1): never {
  console.error(`
Usage: tsx scripts/debug-cursor-agent.ts [options] <workdir> <prompt-file>

Same spawn as the JIRA worker Cursor provider: writes a temp copy of the prompt,
runs: /bin/sh -c '${CURSOR_AGENT_SHELL_SCRIPT}'

Options:
  --timeout-ms <n>    Default: AGENT_TIMEOUT_MS or 600000
  --bin <name>        CURSOR_AGENT_BIN (default: agent)
  --path-prepend <p>  Prepend to PATH in child
  --inherit-env       Pass full process.env to child (CURSOR_AGENT_INHERIT_ENV)
  --attached          Do not use detached spawn
  --stdio inherit     stdio: inherit (default: pipe to this process)
`);
  process.exit(exitCode);
}

function parseArgs(argv: string[]) {
  let timeoutMs = parseInt(process.env.AGENT_TIMEOUT_MS || process.env.CLAUDE_TIMEOUT_MS || "600000", 10);
  let bin = process.env.CURSOR_AGENT_BIN || "agent";
  let pathPrepend = process.env.CURSOR_AGENT_PATH_PREPEND?.trim() || undefined;
  let inheritFullEnv = process.env.CURSOR_AGENT_INHERIT_ENV === "true" || process.env.CURSOR_AGENT_INHERIT_ENV === "1";
  let attached = false;
  let stdioInherit = false;
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--timeout-ms") {
      timeoutMs = parseInt(argv[++i] || "", 10) || timeoutMs;
    } else if (a === "--bin") {
      bin = argv[++i] || bin;
    } else if (a === "--path-prepend") {
      pathPrepend = argv[++i] || pathPrepend;
    } else if (a === "--inherit-env") {
      inheritFullEnv = true;
    } else if (a === "--attached") {
      attached = true;
    } else if (a === "--stdio" && argv[i + 1] === "inherit") {
      i++;
      stdioInherit = true;
    } else if (a === "-h" || a === "--help") {
      usage(0);
    } else if (a.startsWith("-")) {
      console.error("Unknown flag:", a);
      usage();
    } else {
      positionals.push(a);
    }
  }

  if (positionals.length < 2) usage();

  return {
    workDir: resolve(positionals[0]),
    promptFile: resolve(positionals[1]),
    timeoutMs,
    bin,
    pathPrepend,
    inheritFullEnv,
    attached,
    stdioInherit,
  };
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const prompt = readFileSync(opts.promptFile, "utf8");
  const promptPath = writeCursorAgentPromptFile(prompt, "debug");

  const childEnv = buildCursorAgentSpawnEnv({
    command: opts.bin,
    promptFile: promptPath,
    inheritFullEnv: opts.inheritFullEnv,
    pathPrepend: opts.pathPrepend,
  });

  const resolved = resolveAgentBinaryInEnv(opts.bin, childEnv);
  console.error("[debug-cursor-agent] command -v →", resolved);
  console.error("[debug-cursor-agent] inheritFullEnv=", opts.inheritFullEnv, "cwd=", opts.workDir);
  console.error("[debug-cursor-agent] prompt temp file:", promptPath, `(${prompt.length} chars from ${opts.promptFile})`);
  console.error("[debug-cursor-agent] /bin/sh -c", CURSOR_AGENT_SHELL_SCRIPT);

  const cleanup = () => {
    try {
      unlinkSync(promptPath);
    } catch {
      /* ignore */
    }
  };

  const child = spawnCursorAgentShell({
    workDir: opts.workDir,
    promptPath,
    command: opts.bin,
    inheritFullEnv: opts.inheritFullEnv,
    pathPrepend: opts.pathPrepend,
    timeoutMs: opts.timeoutMs,
    detached: !opts.attached,
    stdioInherit: opts.stdioInherit,
  });

  if (!opts.stdioInherit) {
    child.stdout?.on("data", (c: Buffer) => process.stdout.write(c));
    child.stderr?.on("data", (c: Buffer) => process.stderr.write(c));
  }

  let exitCode = 1;
  await new Promise<void>((res, rej) => {
    child.on("error", (err) => {
      cleanup();
      rej(err);
    });
    child.on("close", (code, signal) => {
      cleanup();
      exitCode = code ?? 1;
      console.error("[debug-cursor-agent] exited code=", code, "signal=", signal ?? "");
      res();
    });
  });

  process.exit(exitCode);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
