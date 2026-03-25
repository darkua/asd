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
import { HealthServer } from "./adapters/health/health-server.js";

// GitHub integration
import { GitHubClient } from "./adapters/github/github-client.js";
import { GitHubListener } from "./adapters/github/github-listener.js";
import { GitHubNotifier } from "./adapters/github/github-notifier.js";
import { CompositeFeedbackListener } from "./adapters/composite/composite-feedback-listener.js";
import { CompositeNotifier } from "./adapters/composite/composite-notifier.js";

// Port types (for typed variables)
import type { Notifier } from "./ports/notifier.js";
import type { FeedbackListener } from "./ports/feedback-listener.js";

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

  const slackNotifier = new SlackNotifier(slackClient);

  const isOnce = process.argv.includes("--once");

  // Start SlackClient (only in continuous mode, if tokens configured)
  let slackListener: SlackListener | null = null;
  if (!isOnce && config.slack.botToken && config.slack.appToken) {
    await slackClient.start();
    slackListener = new SlackListener(slackClient, store);
  }

  // Start health check endpoint (if configured)
  const healthServer = new HealthServer(config.worker.healthPort, store);

  // ─── GitHub Integration ──────────────────────────────────
  let notifier: Notifier = slackNotifier;
  let feedbackListener: FeedbackListener | null = slackListener;

  if (config.github.enabled) {
    logger.info("GitHub integration: enabled");

    if (!config.github.token) {
      logger.warn("GITHUB_TOKEN / GH_TOKEN not set — GitHub API calls will fail");
    }
    if (config.worker.healthPort <= 0) {
      logger.warn("HEALTH_PORT is 0 — GitHub webhook endpoint will not be available. Set HEALTH_PORT to enable.");
    }

    const ghClient = new GitHubClient({ token: config.github.token });
    const ghNotifier = new GitHubNotifier(ghClient, store);
    const ghListener = new GitHubListener(ghClient, store, {
      botUsername: config.github.botUsername,
      webhookSecret: config.github.webhookSecret,
    });

    // Register webhook endpoint on HealthServer
    healthServer.registerRoute("/webhooks/github", (req, res) => ghListener.webhook.handle(req, res));

    // Compose notifiers: Slack primary, GitHub secondary
    notifier = new CompositeNotifier(slackNotifier, [ghNotifier]);

    // Compose feedback listeners
    const listeners: FeedbackListener[] = [];
    if (slackListener) listeners.push(slackListener);
    listeners.push(ghListener);
    feedbackListener = new CompositeFeedbackListener(listeners);

    logger.info(`GitHub webhook: POST http://localhost:${config.worker.healthPort}/webhooks/github`);
    logger.info(`GitHub bot username: ${config.github.botUsername || "(not set)"}`);
  }

  // Start health server (must come after route registration)
  if (config.worker.healthPort > 0) {
    await healthServer.start();
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
      maxConcurrent: config.worker.maxConcurrent,
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
