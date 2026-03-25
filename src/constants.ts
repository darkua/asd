// ─── Time Constants ─────────────────────────────────────────
export const ONE_HOUR_MS = 60 * 60 * 1000;
export const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;
export const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
export const PROGRESS_THROTTLE_MS = 60_000;

// ─── Slack Socket Mode Constants ────────────────────────────
export const SLACK_CLIENT_PING_TIMEOUT_MS = 30_000;
export const SLACK_SERVER_PING_TIMEOUT_MS = 60_000;

// ─── Process Constants ──────────────────────────────────────
export const KILL_GRACE_MS = 5_000;
export const KILL_POLL_INTERVAL_MS = 200;
export const GIT_TIMEOUT_MS = 30_000;
export const INSTALL_TIMEOUT_MS = 300_000;

// ─── Display Constants ──────────────────────────────────────
export const MAX_TASK_LIST_DISPLAY = 15;
export const MAX_LOG_SIZE_BYTES = 10 * 1024 * 1024;

// ─── Task Status ────────────────────────────────────────────
export type TaskStatus = "processing" | "review" | "done" | "failed";

export const STATUS_EMOJI: Record<TaskStatus, string> = {
  processing: "🔄",
  review: "👀",
  done: "✅",
  failed: "❌",
};

// ─── Feedback Commands ──────────────────────────────────────
export const CANCEL_COMMANDS = ["cancel", "stop"] as const;

// ─── GitHub Constants ──────────────────────────────────
export const GITHUB_PROGRESS_THROTTLE_MS = 180_000; // 3 min — GitHub API rate limit friendly
export const GITHUB_API_BASE = "https://api.github.com";
export const GITHUB_BOT_SIGNATURE = "<!-- jira-ai-worker -->";
export const GITHUB_CODERABBIT_USERNAME = "coderabbitai[bot]";
