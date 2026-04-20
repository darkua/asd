import { execSync } from "node:child_process";
import { config } from "./config/config.js";
import { logger } from "./logger.js";
import { AGENT_PROVIDER_CLAUDE, AGENT_PROVIDER_CURSOR } from "./constants.js";
import { toErrorMessage } from "./utils/errors.js";
import { ensureRepoFromRemote } from "./utils/ensure-repo-clone.js";

// Adapters
import { ClaudeProvider } from "./adapters/claude/claude-provider.js";
import { CursorAgentProvider } from "./adapters/cursor/cursor-agent-provider.js";
import { GitVCS } from "./adapters/git/git-vcs.js";
import { JiraSource } from "./adapters/jira/jira-source.js";
import { JsonStore } from "./adapters/json-store/json-store.js";
import { SlackClient } from "./adapters/slack/slack-client.js";
import { SlackNotifier } from "./adapters/slack/slack-notifier.js";
import { SlackListener } from "./adapters/slack/slack-listener.js";
import { HealthServer } from "./adapters/health/health-server.js";
import type { AIProvider } from "./ports/ai-provider.js";

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

function verifyClaudeCli(): void {
  try {
    const version = execSync("claude --version", { encoding: "utf-8" }).trim();
    logger.info(`Claude Code: ${version}`);
  } catch {
    throw new Error(
      "Claude Code CLI not found. Install with: npm install -g @anthropic-ai/claude-code",
    );
  }
}

function verifyCursorAgentCli(): void {
  const bin = config.cursorAgent.bin;
  const cmd = `${bin} about`;
  try {
    const out = execSync(cmd, { encoding: "utf-8", stdio: "pipe" }).trim();
    const firstLines = out.split("\n").slice(0, 5).join(" · ");
    const modelSuffix = config.worker.agentModel
      ? ` · AGENT_MODEL override=${config.worker.agentModel}`
      : "";
    logger.info(`Cursor Agent: ${firstLines || "ok"}${modelSuffix}`);
  } catch {
    throw new Error(
      `Cursor Agent CLI not found or not working (${cmd}). Put Cursor CLI \`agent\` on PATH or set CURSOR_AGENT_BIN. ` +
        `Install: https://cursor.com/docs/cli/installation`,
    );
  }
}

function createAIProvider(): AIProvider {
  const common = {
    maxTurns: config.worker.maxTurns,
    timeoutMs: config.worker.timeoutMs,
    model: config.worker.agentModel,
    baseBranch: config.repo.baseBranch,
    draftPr: config.repo.branchDraft,
  };

  if (config.worker.agentProvider === AGENT_PROVIDER_CURSOR) {
    return new CursorAgentProvider({
      ...common,
      command: config.cursorAgent.bin,
      inheritFullEnv: config.cursorAgent.inheritFullEnv,
      pathPrepend: config.cursorAgent.pathPrepend,
    });
  }

  return new ClaudeProvider(common);
}

async function main(): Promise<void> {
  const providerLabel =
    config.worker.agentProvider === AGENT_PROVIDER_CURSOR ? "Cursor Agent" : "Claude Code MAX";

  logger.info("╔══════════════════════════════════════╗");
  logger.info("║   JIRA AI Worker                     ║");
  logger.info("╚══════════════════════════════════════╝");
  logger.info(`Backend: ${providerLabel}`);
  logger.info(`Agent provider: ${config.worker.agentProvider}`);
  logger.info(`Project: ${config.jira.project}`);
  logger.info(`Trigger: label "${config.jira.triggerLabel}"`);
  logger.info(`Repo: ${config.repo.path}`);
  if (config.repo.cloneUrl) {
    logger.info(`REPO_GIT_URL: ${config.repo.cloneUrl}`);
  }
  logger.info(`Poll interval: ${config.worker.pollIntervalMs / 60000} min`);
  logger.info(`Max turns: ${config.worker.maxTurns}`);
  logger.info(`Timeout: ${config.worker.timeoutMs} ms`);
  logger.info(`Agent model override: ${config.worker.agentModel ?? "(provider default)"}`);

  if (config.repo.cloneUrl) {
    if (!config.github.token) {
      throw new Error(
        "REPO_GIT_URL is set but GH_TOKEN / GITHUB_TOKEN is missing. Add a token with repo scope for HTTPS clone and push.",
      );
    }
    ensureRepoFromRemote({
      repoPath: config.repo.path,
      cleanCloneUrl: config.repo.cloneUrl,
      token: config.github.token,
      remote: config.repo.remote,
      baseBranch: config.repo.baseBranch,
    });
  }

  if (config.worker.agentProvider === AGENT_PROVIDER_CLAUDE) {
    verifyClaudeCli();
  } else {
    verifyCursorAgentCli();
  }

  try {
    execSync("gh auth status", { encoding: "utf-8", stdio: "pipe" });
    logger.info("GitHub CLI: authenticated");
  } catch {
    logger.warn(
      "GitHub CLI (gh) not authenticated. The agent will use git + API fallback for PR creation.",
    );
  }

  const store = new JsonStore(config.paths.stateFile);

  const ai = createAIProvider();

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

  const isOnce = process.argv.includes("--once");

  const slackNotifier = new SlackNotifier(slackClient);
  const canRunSlackListener = Boolean(config.slack.botToken && config.slack.appToken);
  if (!canRunSlackListener && !isOnce) {
    throw new Error(
      "Slack is mandatory for normal operation. Missing SLACK_BOT_TOKEN and/or SLACK_APP_TOKEN. " +
        "Ensure your Slack App has Event Subscriptions for `message.channels` and/or `message.groups`.",
    );
  }

  // Start SlackClient (only in continuous mode and when tokens are configured)
  let slackListener: SlackListener | null = null;
  if (!isOnce && canRunSlackListener) {
    await slackClient.start();
    slackListener = new SlackListener(
      slackClient,
      store,
      config.jira.project,
      config.jira.baseUrl,
      config.jira.triggerLabel,
    );
  }

  const healthServer = new HealthServer(config.worker.healthPort, store);

  // ─── GitHub Integration ──────────────────────────────────
  let notifier: Notifier = slackNotifier;
  let feedbackListener: FeedbackListener | null = slackListener;

  if (config.github.enabled) {
    logger.info("GitHub integration: enabled");

    if (!config.github.token) {
      logger.warn("GH_TOKEN / GITHUB_TOKEN not set — GitHub API calls will fail");
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

  await worker.start();
}

main().catch((err) => {
  logger.error(`Fatal: ${toErrorMessage(err)}`);
  process.exit(1);
});
