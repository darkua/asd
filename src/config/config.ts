import "dotenv/config";
import { AGENT_PROVIDER_CLAUDE, AGENT_PROVIDER_CURSOR } from "../constants.js";

function required(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required env var: ${key}. See .env.example`);
  }
  return value;
}

function optional(key: string, fallback: string): string {
  return process.env[key] || fallback;
}

function isTrue(value: string | undefined): boolean {
  return value === "true" || value === "1";
}

function parseAgentProvider(): typeof AGENT_PROVIDER_CLAUDE | typeof AGENT_PROVIDER_CURSOR {
  const raw = optional("AGENT_PROVIDER", AGENT_PROVIDER_CLAUDE).toLowerCase();
  if (raw === AGENT_PROVIDER_CLAUDE) return AGENT_PROVIDER_CLAUDE;
  if (raw === AGENT_PROVIDER_CURSOR) return AGENT_PROVIDER_CURSOR;
  throw new Error(
    `Invalid AGENT_PROVIDER="${raw}". Use "${AGENT_PROVIDER_CLAUDE}" or "${AGENT_PROVIDER_CURSOR}".`,
  );
}

export const config = {
  // JIRA
  jira: {
    baseUrl: required("JIRA_BASE_URL"),        // https://your-org.atlassian.net
    email: required("JIRA_EMAIL"),              // your@email.com
    apiToken: required("JIRA_API_TOKEN"),       // Atlassian API token
    project: required("JIRA_PROJECT_KEY"),      // e.g. "MOW"
    triggerLabel: optional("JIRA_TRIGGER_LABEL", "AI-GEN"),
    doneStatus: optional("JIRA_DONE_STATUS", "In Review"),
  },

  // Git / Repo
  repo: {
    path: required("REPO_PATH"),               // /home/maciej/projects/mowafaqa-backend
    baseBranch: optional("REPO_BASE_BRANCH", "develop"),
    remote: optional("REPO_REMOTE", "origin"),
  },

  // Slack
  slack: {
    webhookUrl: optional("SLACK_WEBHOOK_URL", ""),
    channel: optional("SLACK_CHANNEL", ""),
    botToken: optional("SLACK_BOT_TOKEN", ""),
    appToken: optional("SLACK_APP_TOKEN", ""),
  },

  // GitHub Integration
  github: {
    enabled: optional("GITHUB_INTEGRATION_ENABLED", "false") === "true",
    webhookSecret: optional("GITHUB_WEBHOOK_SECRET", ""),
    botUsername: optional("GITHUB_BOT_USERNAME", ""),
    reviewBotUsers: optional("GITHUB_REVIEW_BOT_USERS", "coderabbitai[bot]")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    token: process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "",
  },

  // Worker
  worker: {
    pollIntervalMs: parseInt(optional("POLL_INTERVAL_MS", "900000"), 10), // 15 min
    maxConcurrent: parseInt(optional("MAX_CONCURRENT", "1"), 10),
    maxTurns: parseInt(optional("AGENT_MAX_TURNS", optional("CLAUDE_MAX_TURNS", "100")), 10),
    timeoutMs: parseInt(optional("AGENT_TIMEOUT_MS", optional("CLAUDE_TIMEOUT_MS", "600000")), 10), // 10 min
    maxFeedbackRounds: parseInt(optional("MAX_FEEDBACK_ROUNDS", "3"), 10),
    healthPort: parseInt(optional("HEALTH_PORT", "0"), 10),
    agentProvider: parseAgentProvider(),
  },

  // Cursor Agent CLI (when AGENT_PROVIDER=cursor): sh + temp prompt file, cwd = worktree
  cursorAgent: {
    bin: optional("CURSOR_AGENT_BIN", "agent"),
    /** Pass entire process.env to the agent child (like your terminal). Risk: also passes worker secrets from .env. */
    inheritFullEnv: isTrue(process.env.CURSOR_AGENT_INHERIT_ENV),
    /** Prepend to PATH in the agent child only (e.g. `/opt/homebrew/bin` when `agent` is not on the worker PATH). */
    pathPrepend: optional("CURSOR_AGENT_PATH_PREPEND", "").trim() || undefined,
  },

  // Paths
  paths: {
    stateFile: optional("STATE_FILE", "./.worker-state.json"),
    logFile: optional("LOG_FILE", ""),
  },
} as const;

// Safety: ensure ANTHROPIC_API_KEY is NOT set — we want MAX subscription billing
if (process.env.ANTHROPIC_API_KEY) {
  console.warn(
    "⚠️  ANTHROPIC_API_KEY is set! Claude Code will use API billing instead of your MAX subscription.\n" +
    "   Unset it with: unset ANTHROPIC_API_KEY",
  );
}
