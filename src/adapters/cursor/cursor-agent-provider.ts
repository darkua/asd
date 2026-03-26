import { unlinkSync } from "node:fs";
import { createInterface } from "node:readline";
import { createLogger } from "../../logger.js";
import type { AIProvider, ProgressCallback } from "../../ports/ai-provider.js";
import type { TaskInfo, AIResult, FeedbackRequest } from "../../ports/types.js";
import {
  buildCursorCombinedPrompt,
  buildFeedbackPrompt,
  buildFeedbackSystemPrompt,
  buildPrompt,
  buildSystemPrompt,
} from "../../utils/agent-prompts.js";
import { extractPrUrlFromOutput } from "../../utils/pr-url.js";
import { killProcessGroup } from "../../utils/process-group.js";
import type { CursorAssistantEvent, CursorStreamEvent } from "./cursor-stream-types.js";
import {
  buildCursorAgentSpawnEnv,
  CURSOR_AGENT_SHELL_SCRIPT,
  resolveAgentBinaryInEnv,
  spawnCursorAgentShell,
  writeCursorAgentPromptFile,
} from "./cursor-agent-shell.js";

type TextBlock = { type: string; text?: string };

export interface CursorAgentProviderConfig {
  maxTurns: number;
  timeoutMs: number;
  baseBranch: string;
  /** Executable on PATH, typically `agent` (Cursor CLI). */
  command: string;
  /** When true, child gets full `process.env` (terminal-like); see `CURSOR_AGENT_INHERIT_ENV`. */
  inheritFullEnv?: boolean;
  /** Optional PATH prefix for the child only (e.g. Homebrew). */
  pathPrepend?: string;
}

/**
 * Spawns Cursor CLI like the shell: write prompt to a temp file, then
 * `"$CURSOR_AGENT_BIN" -p -f --trust "$(cat "$CURSOR_PROMPT_FILE")"` via `/bin/sh -c`, `cwd` = worktree.
 * Parses stdout line-by-line as NDJSON when the CLI emits it; otherwise treats lines as plain text.
 * Wall-clock limit is enforced by Node `spawn` timeout (`timeoutMs`).
 */
export class CursorAgentProvider implements AIProvider {
  private readonly maxTurns: number;
  private readonly timeoutMs: number;
  private readonly baseBranch: string;
  private readonly command: string;
  private readonly inheritFullEnv: boolean;
  private readonly pathPrepend?: string;

  constructor(config: CursorAgentProviderConfig) {
    this.maxTurns = config.maxTurns;
    this.timeoutMs = config.timeoutMs;
    this.baseBranch = config.baseBranch;
    this.command = config.command;
    this.inheritFullEnv = config.inheritFullEnv ?? false;
    this.pathPrepend = config.pathPrepend;
  }

  async run(task: TaskInfo, workDir: string, onProgress?: ProgressCallback): Promise<AIResult> {
    const log = createLogger(task.key);
    const startTime = Date.now();

    const taskPrompt = buildPrompt(task, { baseBranch: this.baseBranch });
    const systemPrompt = buildSystemPrompt();
    const combined = buildCursorCombinedPrompt(systemPrompt, taskPrompt, {
      maxTurns: this.maxTurns,
      timeoutMs: this.timeoutMs,
    });

    log.info("Starting Cursor Agent CLI", {
      workDir,
      maxTurns: this.maxTurns,
      timeoutMs: this.timeoutMs,
      command: this.command,
    });
    log.info(`Combined prompt:\n${combined}`);

    return this.spawnAgent(combined, workDir, log, startTime, task.key, onProgress);
  }

  async runWithFeedback(
    task: TaskInfo,
    workDir: string,
    feedback: FeedbackRequest,
    onProgress?: ProgressCallback,
  ): Promise<AIResult> {
    const log = createLogger(task.key);
    const startTime = Date.now();

    const taskPrompt = buildFeedbackPrompt(task, feedback, { baseBranch: this.baseBranch });
    const systemPrompt = buildFeedbackSystemPrompt(feedback.mode);
    const combined = buildCursorCombinedPrompt(systemPrompt, taskPrompt, {
      maxTurns: this.maxTurns,
      timeoutMs: this.timeoutMs,
    });

    log.info(`Starting Cursor Agent with feedback (round ${feedback.round}, mode: ${feedback.mode})`);
    log.info(`Feedback combined prompt:\n${combined}`);

    return this.spawnAgent(combined, workDir, log, startTime, task.key, onProgress);
  }

  async kill(pid: number): Promise<void> {
    await killProcessGroup(pid, createLogger());
  }

  private spawnAgent(
    prompt: string,
    workDir: string,
    log: ReturnType<typeof createLogger>,
    startTime: number,
    runId: string,
    onProgress?: ProgressCallback,
  ): Promise<AIResult> {
    const promptPath = writeCursorAgentPromptFile(prompt, runId);

    const shellScript = CURSOR_AGENT_SHELL_SCRIPT;
    const childEnv = buildCursorAgentSpawnEnv({
      command: this.command,
      promptFile: promptPath,
      inheritFullEnv: this.inheritFullEnv,
      pathPrepend: this.pathPrepend,
    });
    const resolvedBin = resolveAgentBinaryInEnv(this.command, childEnv);
    const pathPreview = (childEnv.PATH ?? "").slice(0, 400);

    log.info(
      `Cursor spawn: /bin/sh -c ${shellScript} (prompt file ${promptPath}, ${prompt.length} chars) cwd=${workDir} detached=true timeoutMs=${this.timeoutMs}`,
    );
    log.info(
      `Cursor child env: inheritFullEnv=${this.inheritFullEnv} command -v → ${resolvedBin} PATH[0..400]=${pathPreview || "(empty)"}`,
    );

    return new Promise<AIResult>((resolve) => {
      const rawLines: string[] = [];
      /** Plain-text or invalid JSON lines on stdout (CLI often prints errors here, not stderr). */
      const nonJsonStdoutLines: string[] = [];
      const stderrChunks: Buffer[] = [];
      const turnCounter = { value: 0 };
      let childPid: number | undefined;

      const cleanupPromptFile = () => {
        try {
          unlinkSync(promptPath);
        } catch {
          /* ignore */
        }
      };

      const child = spawnCursorAgentShell({
        workDir,
        promptPath,
        command: this.command,
        inheritFullEnv: this.inheritFullEnv,
        pathPrepend: this.pathPrepend,
        timeoutMs: this.timeoutMs,
        detached: true,
        stdioInherit: false,
      });

      if (child.pid) {
        childPid = child.pid;
      }

      const out = child.stdout;
      if (!out) {
        cleanupPromptFile();
        resolve({
          success: false,
          result: "Cursor spawn returned no stdout pipe",
          prUrl: null,
          exitCode: null,
          durationMs: Date.now() - startTime,
          raw: "",
          pid: childPid,
        });
        return;
      }

      const rl = createInterface({ input: out });
      rl.on("line", (line) => {
        rawLines.push(line);
        try {
          const event = JSON.parse(line) as CursorStreamEvent;
          this.processStreamEvent(event, log, turnCounter, startTime, onProgress);
        } catch {
          if (line.trim()) {
            nonJsonStdoutLines.push(line);
            log.debug(`[stdout non-JSON] ${line.slice(0, 500)}`);
          }
        }
      });

      child.stderr?.on("data", (chunk: Buffer) => {
        stderrChunks.push(chunk);
        const line = chunk.toString().trim();
        if (line) log.debug(`[stderr] ${line}`);
      });

      child.on("error", (err) => {
        cleanupPromptFile();
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

      child.on("close", (code, signal) => {
        cleanupPromptFile();
        const durationMs = Date.now() - startTime;
        const rawOutput = rawLines.join("\n");
        const stderrOutput = Buffer.concat(stderrChunks).toString("utf-8");
        const nonJsonStdout = nonJsonStdoutLines.join("\n");
        const exitLabel =
          code === null ? (signal ? `signal ${signal}` : "unknown (null code)") : `code ${code}`;

        log.info(
          `Cursor Agent exited with ${exitLabel} in ${(durationMs / 1000).toFixed(1)}s (${turnCounter.value} progress events)`,
        );

        const resultText = this.extractResultText(rawLines);
        const prUrl = extractPrUrlFromOutput(resultText || rawOutput);

        const ok = code === 0;
        const resultForPipeline = ok
          ? resultText || rawOutput.slice(-2000)
          : this.buildFailureResultText({
              resultText,
              stderrOutput,
              nonJsonStdout,
              rawOutputTail: rawOutput.slice(-2000),
              exitCode: code ?? -1,
              signal: signal ?? undefined,
            });

        if (!ok) {
          const stderrTail = stderrOutput.trim().slice(-1500);
          const stdoutTail = nonJsonStdout.trim().slice(-1500);
          const summaryParts = [
            stderrTail && `stderr: ${stderrTail}`,
            stdoutTail && `stdout (non-stream-json): ${stdoutTail}`,
            !stderrTail &&
              !stdoutTail &&
              `no stderr/plain stdout (${rawLines.length} line(s) total on stdout)`,
          ].filter((p): p is string => Boolean(p));
          log.error(`Cursor Agent failed (${exitLabel}) — ${summaryParts.join(" | ")}`, {
            exitCode: code,
            signal: signal ?? undefined,
            spawnShell: "/bin/sh -c",
            cursorAgentBin: this.command,
            promptFile: promptPath,
            promptChars: prompt.length,
            stdoutLineCount: rawLines.length,
            stderrChars: stderrOutput.length,
            nonJsonStdoutChars: nonJsonStdout.length,
          });
        }

        resolve({
          success: ok && prUrl !== null,
          result: resultForPipeline,
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
    event: CursorStreamEvent,
    log: ReturnType<typeof createLogger>,
    turnCounter: { value: number },
    startTime: number,
    onProgress?: ProgressCallback,
  ): void {
    try {
      if (event.type === "assistant") {
        const a = event as CursorAssistantEvent;
        const content = a.message?.content;
        if (content) {
          for (const block of content) {
            if (block.type === "text" && block.text) {
              log.info(`[response] ${block.text.slice(0, 2000)}`);
            }
          }
          turnCounter.value++;

          if (onProgress) {
            const textBlock = content.find((b: TextBlock) => b.type === "text" && b.text);
            if (textBlock?.text) {
              onProgress({
                turn: turnCounter.value,
                maxTurns: this.maxTurns,
                type: "text",
                detail: textBlock.text.slice(0, 120),
                elapsedMs: Date.now() - startTime,
              });
            }
          }
        }
      } else if (event.type === "tool_call" && "subtype" in event && event.subtype === "started") {
        const detail = this.summarizeToolCall(event);
        log.info(`[tool_call] ${detail}`);
        turnCounter.value++;
        if (onProgress) {
          onProgress({
            turn: turnCounter.value,
            maxTurns: this.maxTurns,
            type: "tool_use",
            detail,
            elapsedMs: Date.now() - startTime,
          });
        }
      } else if (event.type === "result") {
        const r = event as { duration_ms?: number; result?: string; subtype?: string };
        log.info(`[result] subtype=${r.subtype || "?"}, duration_ms=${r.duration_ms ?? "?"}`);
        if (onProgress) {
          onProgress({
            turn: turnCounter.value,
            maxTurns: this.maxTurns,
            type: "result",
            detail: r.subtype || "done",
            elapsedMs: Date.now() - startTime,
          });
        }
      }
    } catch {
      // ignore malformed event slices
    }
  }

  private summarizeToolCall(event: CursorStreamEvent): string {
    const tc = (event as { tool_call?: Record<string, { args?: { path?: string } }> }).tool_call;
    if (!tc) return "tool";
    const keys = Object.keys(tc);
    if (keys.length === 0) return "tool";
    const first = keys[0];
    const args = tc[first]?.args;
    if (args?.path) return `${first}:${args.path}`;
    return first;
  }

  private buildFailureResultText(parts: {
    resultText: string;
    stderrOutput: string;
    nonJsonStdout: string;
    rawOutputTail: string;
    exitCode: number;
    signal?: string;
  }): string {
    const { resultText, stderrOutput, nonJsonStdout, rawOutputTail, exitCode, signal } = parts;
    const stderrTrim = stderrOutput.trim();
    const nonJsonTrim = nonJsonStdout.trim();
    const chunks = [resultText.trim(), stderrTrim, nonJsonTrim].filter((s) => s.length > 0);
    if (chunks.length > 0) {
      return chunks.join("\n---\n").slice(-4000);
    }
    const tail = rawOutputTail.trim();
    if (tail.length > 0) return tail;
    const why =
      signal != null
        ? `killed by signal ${signal}`
        : `exit code ${exitCode}`;
    return `Cursor Agent ended (${why}) with no stdout/stderr captured; check CLI login, PATH (\`agent about\`), and worktree cwd.`;
  }

  private extractResultText(lines: string[]): string {
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const event = JSON.parse(lines[i]) as CursorStreamEvent;
        if (event.type === "result" && "result" in event && typeof event.result === "string") {
          return event.result;
        }
        if (event.type === "assistant") {
          const a = event as CursorAssistantEvent;
          const content = a.message?.content;
          if (content) {
            const texts = content
              .filter((b: TextBlock): b is { type: "text"; text: string } =>
                b.type === "text" && typeof b.text === "string" && b.text.length > 0)
              .map((b: { text: string }) => b.text);
            if (texts.length > 0) return texts.join("\n");
          }
        }
      } catch {
        // skip
      }
    }
    return "";
  }
}
