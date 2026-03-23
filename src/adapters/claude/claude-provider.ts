import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { createLogger } from "../../logger.js";
import type { AIProvider } from "../../ports/ai-provider.js";
import type { TaskInfo, AIResult, FeedbackRequest } from "../../ports/types.js";
import {
  ALLOWED_TOOLS,
  buildPrompt,
  buildSystemPrompt,
  buildFeedbackPrompt,
  buildFeedbackSystemPrompt,
} from "./prompts.js";

export class ClaudeProvider implements AIProvider {
  private readonly maxTurns: number;
  private readonly timeoutMs: number;
  private readonly baseBranch: string;

  constructor(config: { maxTurns: number; timeoutMs: number; baseBranch: string }) {
    this.maxTurns = config.maxTurns;
    this.timeoutMs = config.timeoutMs;
    this.baseBranch = config.baseBranch;
  }

  async run(task: TaskInfo, workDir: string): Promise<AIResult> {
    const log = createLogger(task.key);
    const startTime = Date.now();

    const prompt = buildPrompt(task, { baseBranch: this.baseBranch });
    const systemPrompt = buildSystemPrompt();

    const args = [
      "-p", prompt,
      "--append-system-prompt", systemPrompt,
      "--output-format", "stream-json",
      "--max-turns", String(this.maxTurns),
      "--verbose",
      "--allowedTools", ALLOWED_TOOLS,
    ];

    log.info("Starting Claude Code CLI", { workDir, maxTurns: this.maxTurns });
    log.info(`Prompt sent to Claude:\n${prompt}`);
    log.info(`System prompt sent to Claude:\n${systemPrompt}`);

    return this.spawnClaude(args, workDir, task.key, log, startTime);
  }

  async runWithFeedback(task: TaskInfo, workDir: string, feedback: FeedbackRequest): Promise<AIResult> {
    const log = createLogger(task.key);
    const startTime = Date.now();

    const prompt = buildFeedbackPrompt(task, feedback, { baseBranch: this.baseBranch });
    const systemPrompt = buildFeedbackSystemPrompt(feedback.mode);

    const args = [
      "-p", prompt,
      "--append-system-prompt", systemPrompt,
      "--output-format", "stream-json",
      "--max-turns", String(this.maxTurns),
      "--verbose",
      "--allowedTools", ALLOWED_TOOLS,
    ];

    log.info(`Starting Claude Code with feedback (round ${feedback.round}, mode: ${feedback.mode})`);
    log.info(`Feedback prompt:\n${prompt}`);

    return this.spawnClaude(args, workDir, task.key, log, startTime);
  }

  async kill(pid: number): Promise<void> {
    const log = createLogger();

    try {
      process.kill(-pid, 0);
    } catch {
      log.debug(`Process group ${pid} already dead`);
      return;
    }

    log.info(`Killing Claude Code process group ${pid}`);

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
      }, 200);

      setTimeout(() => {
        clearInterval(checkInterval);
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          // already dead
        }
        resolve();
      }, 5000);
    });

    log.info(`Process group ${pid} terminated`);
  }

  private buildSafeEnv(): Record<string, string | undefined> {
    const ALLOWED_ENV_KEYS = [
      "HOME", "PATH", "SHELL", "USER", "LOGNAME",
      "LANG", "LC_ALL", "LC_CTYPE",
      "TERM", "TERM_PROGRAM",
      "NODE_ENV", "NODE_OPTIONS",
      "GITHUB_TOKEN", "GH_TOKEN",
      "SSH_AUTH_SOCK", "SSH_AGENT_PID",
      "TMPDIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME",
    ];

    const safeEnv: Record<string, string | undefined> = {};
    for (const key of ALLOWED_ENV_KEYS) {
      if (process.env[key]) {
        safeEnv[key] = process.env[key];
      }
    }
    // Explicitly ensure no API key billing
    safeEnv.ANTHROPIC_API_KEY = undefined;
    return safeEnv;
  }

  private spawnClaude(
    args: string[],
    workDir: string,
    taskKey: string,
    log: ReturnType<typeof createLogger>,
    startTime: number,
  ): Promise<AIResult> {
    return new Promise<AIResult>((resolve) => {
      const rawLines: string[] = [];
      const stderrChunks: Buffer[] = [];
      const turnCounter = { value: 0 };
      let childPid: number | undefined;

      const child = spawn("claude", args, {
        cwd: workDir,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: this.timeoutMs,
        env: this.buildSafeEnv(),
      });

      if (child.pid) {
        childPid = child.pid;
      }

      // Parse streaming JSON line-by-line for real-time logging
      const rl = createInterface({ input: child.stdout });
      rl.on("line", (line) => {
        rawLines.push(line);
        try {
          const event = JSON.parse(line);
          this.processStreamEvent(event, log, turnCounter);
        } catch {
          // Not JSON — log raw
          if (line.trim()) log.debug(`[stdout] ${line.slice(0, 500)}`);
        }
      });

      child.stderr.on("data", (chunk: Buffer) => {
        stderrChunks.push(chunk);
        const line = chunk.toString().trim();
        if (line) log.debug(`[stderr] ${line}`);
      });

      child.on("error", (err) => {
        log.error(`Process error: ${err.message}`);
        resolve({
          success: false,
          result: `Process error: ${err.message}`,
          prUrl: null,
          exitCode: null,
          durationMs: Date.now() - startTime,
          raw: "",
          pid: childPid,
        });
      });

      child.on("close", (code) => {
        const durationMs = Date.now() - startTime;
        const rawOutput = rawLines.join("\n");
        const stderrOutput = Buffer.concat(stderrChunks).toString("utf-8");

        log.info(`Claude Code exited with code ${code} in ${(durationMs / 1000).toFixed(1)}s (${turnCounter.value} turns)`);

        // Extract final result text from the last assistant message
        const resultText = this.extractResultText(rawLines);
        const prUrl = this.extractPrUrl(resultText || rawOutput);

        if (code !== 0) {
          log.error("Claude Code failed", {
            exitCode: code,
            stderr: stderrOutput.slice(-500),
          });
        }

        resolve({
          success: code === 0 && prUrl !== null,
          result: resultText || rawOutput.slice(-2000),
          prUrl,
          exitCode: code,
          durationMs,
          raw: rawOutput,
          pid: childPid,
        });
      });
    });
  }

  private processStreamEvent(
    event: any,
    log: ReturnType<typeof createLogger>,
    turnCounter: { value: number },
  ): void {
    try {
      if (event.type === "assistant" && event.message?.content) {
        for (const block of event.message.content) {
          if (block.type === "thinking" && block.thinking) {
            log.info(`[thinking] ${block.thinking.slice(0, 2000)}`);
          } else if (block.type === "text" && block.text) {
            log.info(`[response] ${block.text.slice(0, 2000)}`);
          } else if (block.type === "tool_use") {
            const input = typeof block.input === "string"
              ? block.input.slice(0, 300)
              : JSON.stringify(block.input).slice(0, 300);
            log.info(`[tool_use] ${block.name}: ${input}`);
          }
        }
        turnCounter.value++;
      } else if (event.type === "result") {
        log.info(`[result] stop_reason=${event.stop_reason}, turns=${event.num_turns}, cost=$${event.total_cost_usd?.toFixed(2) || "?"}`);
      }
    } catch {
      // Ignore parse errors in individual events
    }
  }

  private extractResultText(lines: string[]): string {
    let lastText = "";
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const event = JSON.parse(lines[i]);
        if (event.type === "assistant" && event.message?.content) {
          const texts = event.message.content
            .filter((b: any) => b.type === "text")
            .map((b: any) => b.text);
          if (texts.length > 0) {
            lastText = texts.join("\n");
            break;
          }
        }
        // Also check "result" type which has the final output
        if (event.type === "result" && event.result) {
          return event.result;
        }
      } catch {
        // skip non-JSON lines
      }
    }
    return lastText;
  }

  private extractPrUrl(text: string): string | null {
    // Match explicit PR_URL output
    const prUrlMatch = text.match(/PR_URL:\s*(https:\/\/github\.com\/[^\s]+\/pull\/\d+)/i);
    if (prUrlMatch) return prUrlMatch[1];

    // Fallback: match any GitHub PR URL in the output
    const ghMatch = text.match(/(https:\/\/github\.com\/[^\s]+\/pull\/\d+)/);
    if (ghMatch) return ghMatch[1];

    return null;
  }
}
