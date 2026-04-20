import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { createLogger } from "../../logger.js";
import type { AIProvider, ProgressCallback } from "../../ports/ai-provider.js";
import type { TaskInfo, AIResult, FeedbackRequest } from "../../ports/types.js";
import {
  buildFeedbackPrompt,
  buildFeedbackSystemPrompt,
  buildPrompt,
  buildSystemPrompt,
} from "../../utils/agent-prompts.js";
import { extractPrUrlFromOutput } from "../../utils/pr-url.js";
import { killProcessGroup } from "../../utils/process-group.js";
import type { ClaudeStreamEvent, ContentBlock } from "./stream-types.js";

const ALLOWED_TOOLS = [
  "Read", "Write", "Edit", "Glob", "Grep",
  "Bash(git:*)",
  "Bash(gh pr create:*)",
  "Bash(gh pr view:*)",
  "Bash(npm:*)",
  "Bash(npx:*)",
  "Bash(yarn:*)",
  "Bash(pnpm:*)",
  "Bash(cat:*)",
  "Bash(ls:*)",
  "Bash(find:*)",
  "Bash(head:*)",
  "Bash(tail:*)",
  "Bash(wc:*)",
  "Bash(mkdir:*)",
  "Bash(cp:*)",
  "Bash(mv:*)",
].join(",");

export class ClaudeProvider implements AIProvider {
  private readonly maxTurns: number;
  private readonly timeoutMs: number;
  private readonly model?: string;
  private readonly baseBranch: string;
  private readonly draftPr: boolean;

  constructor(config: { maxTurns: number; timeoutMs: number; model?: string; baseBranch: string; draftPr: boolean }) {
    this.maxTurns = config.maxTurns;
    this.timeoutMs = config.timeoutMs;
    this.model = config.model;
    this.baseBranch = config.baseBranch;
    this.draftPr = config.draftPr;
  }

  async run(task: TaskInfo, workDir: string, onProgress?: ProgressCallback): Promise<AIResult> {
    const log = createLogger(task.key);
    const startTime = Date.now();

    const prompt = buildPrompt(task, { baseBranch: this.baseBranch, draftPr: this.draftPr });
    const systemPrompt = buildSystemPrompt();

    const args = [
      "-p", prompt,
      "--append-system-prompt", systemPrompt,
      "--output-format", "stream-json",
      "--max-turns", String(this.maxTurns),
      "--verbose",
      "--allowedTools", ALLOWED_TOOLS,
    ];
    if (this.model) {
      args.push("--model", this.model);
    }

    log.info("Starting Claude Code CLI", {
      workDir,
      maxTurns: this.maxTurns,
      model: this.model ?? "(provider default)",
    });
    log.info(`Prompt sent to Claude:\n${prompt}`);
    log.info(`System prompt sent to Claude:\n${systemPrompt}`);

    return this.spawnClaude(args, workDir, log, startTime, onProgress);
  }

  async runWithFeedback(task: TaskInfo, workDir: string, feedback: FeedbackRequest, onProgress?: ProgressCallback): Promise<AIResult> {
    const log = createLogger(task.key);
    const startTime = Date.now();

    const prompt = buildFeedbackPrompt(task, feedback, { baseBranch: this.baseBranch, draftPr: this.draftPr });
    const systemPrompt = buildFeedbackSystemPrompt(feedback.mode);

    const args = [
      "-p", prompt,
      "--append-system-prompt", systemPrompt,
      "--output-format", "stream-json",
      "--max-turns", String(this.maxTurns),
      "--verbose",
      "--allowedTools", ALLOWED_TOOLS,
    ];
    if (this.model) {
      args.push("--model", this.model);
    }

    log.info(`Starting Claude Code with feedback (round ${feedback.round}, mode: ${feedback.mode})`);
    log.info(`Feedback prompt:\n${prompt}`);

    return this.spawnClaude(args, workDir, log, startTime, onProgress);
  }

  async kill(pid: number): Promise<void> {
    await killProcessGroup(pid, createLogger());
  }

  private buildSafeEnv(): Record<string, string | undefined> {
    const ALLOWED_ENV_KEYS = [
      "HOME", "PATH", "SHELL", "USER", "LOGNAME",
      "LANG", "LC_ALL", "LC_CTYPE",
      "TERM", "TERM_PROGRAM",
      "NODE_ENV", "NODE_OPTIONS",
      "GH_TOKEN", "GITHUB_TOKEN",
      "SSH_AUTH_SOCK", "SSH_AGENT_PID",
      "TMPDIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME",
    ];

    const safeEnv: Record<string, string | undefined> = {};
    for (const key of ALLOWED_ENV_KEYS) {
      if (process.env[key]) {
        safeEnv[key] = process.env[key];
      }
    }
    safeEnv.ANTHROPIC_API_KEY = undefined;
    return safeEnv;
  }

  private spawnClaude(
    args: string[],
    workDir: string,
    log: ReturnType<typeof createLogger>,
    startTime: number,
    onProgress?: ProgressCallback,
  ): Promise<AIResult> {
    return new Promise<AIResult>((resolve) => {
      const rawLines: string[] = [];
      const stderrChunks: Buffer[] = [];
      const turnCounter = { value: 0 };
      const costTracker = { value: undefined as number | undefined };
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

      const rl = createInterface({ input: child.stdout });
      rl.on("line", (line) => {
        rawLines.push(line);
        try {
          const event = JSON.parse(line) as ClaudeStreamEvent;
          this.processStreamEvent(event, log, turnCounter, costTracker, startTime, onProgress);
        } catch {
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

        const resultText = this.extractResultText(rawLines);
        const prUrl = extractPrUrlFromOutput(resultText || rawOutput);

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
          costUsd: costTracker.value,
        });
      });
    });
  }

  private processStreamEvent(
    event: ClaudeStreamEvent,
    log: ReturnType<typeof createLogger>,
    turnCounter: { value: number },
    costTracker: { value: number | undefined },
    startTime: number,
    onProgress?: ProgressCallback,
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

        if (onProgress) {
          for (const block of event.message.content) {
            if (block.type === "tool_use") {
              onProgress({
                turn: turnCounter.value,
                maxTurns: this.maxTurns,
                type: "tool_use",
                detail: block.name,
                elapsedMs: Date.now() - startTime,
              });
            } else if (block.type === "thinking") {
              onProgress({
                turn: turnCounter.value,
                maxTurns: this.maxTurns,
                type: "thinking",
                detail: "reasoning",
                elapsedMs: Date.now() - startTime,
              });
            }
          }
        }
      } else if (event.type === "result") {
        if (event.total_cost_usd != null) {
          costTracker.value = event.total_cost_usd;
        }
        log.info(`[result] stop_reason=${event.stop_reason}, turns=${event.num_turns}, cost=$${event.total_cost_usd?.toFixed(2) || "?"}`);

        if (onProgress) {
          onProgress({
            turn: turnCounter.value,
            maxTurns: this.maxTurns,
            type: "result",
            detail: event.stop_reason || "done",
            elapsedMs: Date.now() - startTime,
          });
        }
      }
    } catch {
      // Ignore parse errors in individual events
    }
  }

  private extractResultText(lines: string[]): string {
    let lastText = "";
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const event = JSON.parse(lines[i]) as ClaudeStreamEvent;
        if (event.type === "assistant" && event.message?.content) {
          const texts = event.message.content
            .filter((b): b is ContentBlock & { type: "text"; text: string } => b.type === "text")
            .map((b) => b.text);
          if (texts.length > 0) {
            lastText = texts.join("\n");
            break;
          }
        }
        if (event.type === "result" && event.result) {
          return event.result;
        }
      } catch {
        // skip non-JSON lines
      }
    }
    return lastText;
  }
}
