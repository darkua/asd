// ─── GitHub Webhook Payload Types ─────────────────────────

export interface GitHubUser {
  login: string;
  id: number;
}

export interface GitHubComment {
  id: number;
  body: string;
  user: GitHubUser;
  html_url: string;
  created_at: string;
}

export interface GitHubReview {
  id: number;
  body: string;
  state: string; // "approved", "changes_requested", "commented", "dismissed"
  user: GitHubUser;
  html_url: string;
}

export interface GitHubReviewComment {
  id: number;
  body: string;
  path: string;
  line: number | null;
  start_line: number | null;
  user: GitHubUser;
}

export interface GitHubPullRequest {
  number: number;
  html_url: string;
  head: { ref: string };
  title: string;
}

export interface GitHubRepository {
  full_name: string;
  owner: { login: string };
  name: string;
}

export interface GitHubIssue {
  number: number;
  html_url: string;
  pull_request?: { html_url: string };
}

/** Covers issue_comment, pull_request_review, and pull_request_review_comment events */
export interface GitHubWebhookPayload {
  action: string;
  comment?: GitHubComment;
  review?: GitHubReview;
  repository: GitHubRepository;
  issue?: GitHubIssue;
  pull_request?: GitHubPullRequest;
}

/** Parsed PR reference extracted from a webhook payload or PR URL */
export interface PrRef {
  owner: string;
  repo: string;
  number: number;
}
