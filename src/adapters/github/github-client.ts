import { createLogger } from "../../logger.js";
import { GITHUB_API_BASE } from "../../constants.js";
import type { PrRef } from "./github-types.js";

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

  /** Post a comment on a PR (uses the Issues API which works for PRs). */
  async postComment(owner: string, repo: string, issueNumber: number, body: string): Promise<void> {
    await this.request("POST", `/repos/${owner}/${repo}/issues/${issueNumber}/comments`, { body });
    log.debug(`Posted comment on ${owner}/${repo}#${issueNumber}`);
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
