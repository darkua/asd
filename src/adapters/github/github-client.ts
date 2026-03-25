import { createLogger } from "../../logger.js";
import { GITHUB_API_BASE, GITHUB_BOT_SIGNATURE } from "../../constants.js";
import type { PrRef, GitHubReview, GitHubReviewComment } from "./github-types.js";

const log = createLogger();

export interface GitHubClientConfig {
  token: string;
}

export class GitHubClient {
  private readonly token: string;
  private authenticatedUser: string | null = null;

  constructor(config: GitHubClientConfig) {
    this.token = config.token;
  }

  /** Resolve the authenticated user's login (for self-loop prevention). */
  async resolveAuthenticatedUser(): Promise<string> {
    if (this.authenticatedUser) return this.authenticatedUser;

    try {
      const data = await this.request<{ login: string }>("GET", "/user");
      this.authenticatedUser = data.login;
      log.info(`GitHub authenticated as: ${this.authenticatedUser}`);
    } catch {
      log.warn("Could not resolve GitHub authenticated user — self-loop prevention disabled");
      this.authenticatedUser = "";
    }
    return this.authenticatedUser;
  }

  /** Post a comment on a PR. Returns the comment ID for later editing. */
  async postComment(owner: string, repo: string, issueNumber: number, body: string): Promise<number> {
    const signed = `${body}\n${GITHUB_BOT_SIGNATURE}`;
    const result = await this.request<{ id: number }>("POST", `/repos/${owner}/${repo}/issues/${issueNumber}/comments`, { body: signed });
    log.debug(`Posted comment on ${owner}/${repo}#${issueNumber} (id: ${result.id})`);
    return result.id;
  }

  /** Fetch all reviews on a PR. */
  async getReviews(owner: string, repo: string, prNumber: number): Promise<GitHubReview[]> {
    return this.request<GitHubReview[]>("GET", `/repos/${owner}/${repo}/pulls/${prNumber}/reviews`);
  }

  /** Fetch all comments from a specific PR review. */
  async getReviewComments(owner: string, repo: string, prNumber: number, reviewId: number): Promise<GitHubReviewComment[]> {
    return this.request<GitHubReviewComment[]>("GET", `/repos/${owner}/${repo}/pulls/${prNumber}/reviews/${reviewId}/comments`);
  }

  /** Reply to a specific review comment on a PR. Returns the new comment ID. */
  async replyToReviewComment(owner: string, repo: string, prNumber: number, commentId: number, body: string): Promise<number> {
    const signed = `${body}\n${GITHUB_BOT_SIGNATURE}`;
    const result = await this.request<{ id: number }>("POST", `/repos/${owner}/${repo}/pulls/${prNumber}/comments/${commentId}/replies`, { body: signed });
    log.debug(`Replied to review comment ${commentId} on ${owner}/${repo}#${prNumber} (new id: ${result.id})`);
    return result.id;
  }

  /** Edit an existing issue comment. */
  async editComment(owner: string, repo: string, commentId: number, body: string): Promise<void> {
    const signed = `${body}\n${GITHUB_BOT_SIGNATURE}`;
    await this.request("PATCH", `/repos/${owner}/${repo}/issues/comments/${commentId}`, { body: signed });
    log.debug(`Edited comment ${commentId} on ${owner}/${repo}`);
  }

  /** Edit an existing pull request review comment. */
  async editReviewComment(owner: string, repo: string, commentId: number, body: string): Promise<void> {
    const signed = `${body}\n${GITHUB_BOT_SIGNATURE}`;
    await this.request("PATCH", `/repos/${owner}/${repo}/pulls/comments/${commentId}`, { body: signed });
    log.debug(`Edited review comment ${commentId} on ${owner}/${repo}`);
  }

  /**
   * Parse a GitHub PR URL into its components.
   * Handles: https://github.com/owner/repo/pull/123
   */
  static parsePrUrl(url: string): PrRef | null {
    const match = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
    if (!match) return null;
    return { owner: match[1], repo: match[2], number: parseInt(match[3], 10) };
  }

  private async request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${GITHUB_API_BASE}${path}`;
    const headers: Record<string, string> = {
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "jira-ai-worker",
    };
    if (this.token) {
      headers.Authorization = `Bearer ${this.token}`;
    }

    const response = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`GitHub API ${method} ${path} failed (${response.status}): ${text}`);
    }

    if (response.status === 204) return undefined as T;
    return response.json() as Promise<T>;
  }
}
