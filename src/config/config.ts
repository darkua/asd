import "dotenv/config";

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

  // Worker
  worker: {
    pollIntervalMs: parseInt(optional("POLL_INTERVAL_MS", "900000")), // 15 min
    maxConcurrent: parseInt(optional("MAX_CONCURRENT", "1")),
    maxTurns: parseInt(optional("CLAUDE_MAX_TURNS", "100")),
    timeoutMs: parseInt(optional("CLAUDE_TIMEOUT_MS", "600000")),     // 10 min
    maxFeedbackRounds: parseInt(optional("MAX_FEEDBACK_ROUNDS", "3")),
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
    "   Unset it with: unset ANTHROPIC_API_KEY"
  );
}
