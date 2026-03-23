import { execSync } from "node:child_process";
import { config } from "./config/config.js";
import { logger } from "./logger.js";

// Adapters
import { ClaudeProvider } from "./adapters/claude/claude-provider.js";
import { GitVCS } from "./adapters/git/git-vcs.js";
import { JiraSource } from "./adapters/jira/jira-source.js";
import { JsonStore } from "./adapters/json-store/json-store.js";
import { SlackClient } from "./adapters/slack/slack-client.js";
import { SlackNotifier } from "./adapters/slack/slack-notifier.js";
import { SlackListener } from "./adapters/slack/slack-listener.js";

// Core
import { TaskPipeline } from "./core/task-pipeline.js";
import { Worker } from "./core/worker.js";

async function main(): Promise<void> {
  // ─── Banner ──────────────────────────────────────────────
  logger.info("╔══════════════════════════════════════╗");
  logger.info("║   JIRA AI Worker · Claude Code MAX   ║");
  logger.info("╚══════════════════════════════════════╝");
  logger.info(`Project: ${config.jira.project}`);
  logger.info(`Trigger: label "${config.jira.triggerLabel}"`);
  logger.info(`Repo: ${config.repo.path}`);
  logger.info(`Poll interval: ${config.worker.pollIntervalMs / 60000} min`);
  logger.info(`Max turns: ${config.worker.maxTurns}`);

  // ─── Prerequisites ──────────────────────────────────────
  // NOTE: execSync with hardcoded strings is safe here — no user input involved.
  try {
    const version = execSync("claude --version", { encoding: "utf-8" }).trim();
    logger.info(`Claude Code: ${version}`);
  } catch {
    throw new Error(
      "Claude Code CLI not found. Install with: npm install -g @anthropic-ai/claude-code",
    );
  }

  try {
    execSync("gh auth status", { encoding: "utf-8", stdio: "pipe" });
    logger.info("GitHub CLI: authenticated");
  } catch {
    logger.warn(
      "GitHub CLI (gh) not authenticated. Claude will use git + API fallback for PR creation.",
    );
  }

  // ─── Create Adapters ────────────────────────────────────
  const store = new JsonStore(config.paths.stateFile);

  const ai = new ClaudeProvider({
    maxTurns: config.worker.maxTurns,
    timeoutMs: config.worker.timeoutMs,
    baseBranch: config.repo.baseBranch,
  });

  const vcs = new GitVCS({
    path: config.repo.path,
    baseBranch: config.repo.baseBranch,
    remote: config.repo.remote,
  });

  const taskSource = new JiraSource({
    baseUrl: config.jira.baseUrl,
    email: config.jira.email,
    apiToken: config.jira.apiToken,
    project: config.jira.project,
    triggerLabel: config.jira.triggerLabel,
    doneStatus: config.jira.doneStatus,
  });

  const slackClient = new SlackClient({
    botToken: config.slack.botToken,
    appToken: config.slack.appToken,
    channel: config.slack.channel,
    webhookUrl: config.slack.webhookUrl,
  });

  const notifier = new SlackNotifier(slackClient);

  const isOnce = process.argv.includes("--once");

  // Start SlackClient (only in continuous mode, if tokens configured)
  let feedbackListener: SlackListener | null = null;
  if (!isOnce && config.slack.botToken && config.slack.appToken) {
    await slackClient.start();
    feedbackListener = new SlackListener(slackClient, store);
  }

  // ─── Create Core ────────────────────────────────────────
  const pipeline = new TaskPipeline(ai, taskSource, notifier, store, vcs);

  const worker = new Worker(
    pipeline,
    feedbackListener,
    notifier,
    taskSource,
    store,
    vcs,
    ai,
    {
      pollIntervalMs: config.worker.pollIntervalMs,
      maxTurns: config.worker.maxTurns,
      timeoutMs: config.worker.timeoutMs,
      maxFeedbackRounds: config.worker.maxFeedbackRounds,
      isOnce,
    },
  );

  // ─── Start ──────────────────────────────────────────────
  await worker.start();
}

main().catch((err) => {
  logger.error(`Fatal: ${err}`);
  process.exit(1);
});
