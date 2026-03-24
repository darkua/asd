import type { Notifier } from "../../ports/notifier.js";
import type { TaskInfo, AIResult, ThreadRef } from "../../ports/types.js";
import type { TaskQueryStore } from "../../ports/store.js";
import { GitHubClient } from "./github-client.js";
import { createLogger } from "../../logger.js";
import { toErrorMessage } from "../../utils/errors.js";
import { GITHUB_PROGRESS_THROTTLE_MS } from "../../constants.js";

const log = createLogger();

export class GitHubNotifier implements Notifier {
  private lastProgressUpdate = new Map<string, number>();

  constructor(
    private readonly client: GitHubClient,
    private readonly store: TaskQueryStore,
  ) {}

  async notifyWorkerStart(): Promise<void> {
    // No-op — GitHub doesn't need a startup notification
  }

  async notifyTaskStarted(_task: TaskInfo): Promise<ThreadRef | undefined> {
    // No-op — PR doesn't exist yet at task start
    return undefined;
  }

  async notifyTaskStatus(thread: ThreadRef, text: string): Promise<void> {
    // Throttle progress updates (GitHub API rate limits)
    const now = Date.now();
    const key = `${thread.channel}:${thread.id}`;
    const lastUpdate = this.lastProgressUpdate.get(key) ?? 0;
    if (now - lastUpdate < GITHUB_PROGRESS_THROTTLE_MS) return;
    this.lastProgressUpdate.set(key, now);

    const prRef = this.resolveThreadRef(thread);
    if (!prRef) return;

    try {
      await this.client.postComment(prRef.owner, prRef.repo, prRef.number, `🔄 ${text}`);
    } catch (err) {
      log.warn(`GitHub progress update failed: ${toErrorMessage(err)}`);
    }
  }

  async notifyTaskCompleted(
    task: TaskInfo,
    result: AIResult,
    _thread?: ThreadRef,
  ): Promise<ThreadRef | undefined> {
    const prRef = result.prUrl ? GitHubClient.parsePrUrl(result.prUrl) : null;
    if (!prRef) return undefined;

    try {
      const duration = (result.durationMs / 1000).toFixed(0);
      const cost = result.costUsd ? ` · Cost: $${result.costUsd.toFixed(2)}` : "";
      await this.client.postComment(
        prRef.owner,
        prRef.repo,
        prRef.number,
        `✅ **Implementation complete** for ${task.key}\nDuration: ${duration}s${cost}\n\nPR is ready for review.`,
      );
      return { id: String(prRef.number), channel: `github:${prRef.owner}/${prRef.repo}` };
    } catch (err) {
      log.warn(`GitHub completion notification failed: ${toErrorMessage(err)}`);
      return undefined;
    }
  }

  async notifyTaskFailed(
    task: TaskInfo,
    error: string,
    _thread?: ThreadRef,
  ): Promise<ThreadRef | undefined> {
    // Try to find the PR from the store
    const storedTask = this.store.getTask(task.key);
    if (!storedTask?.prUrl) return undefined;

    const prRef = GitHubClient.parsePrUrl(storedTask.prUrl);
    if (!prRef) return undefined;

    try {
      await this.client.postComment(
        prRef.owner,
        prRef.repo,
        prRef.number,
        `❌ **Implementation failed** for ${task.key}\n\n\`\`\`\n${error.slice(0, 500)}\n\`\`\``,
      );
      return { id: String(prRef.number), channel: `github:${prRef.owner}/${prRef.repo}` };
    } catch (err) {
      log.warn(`GitHub failure notification failed: ${toErrorMessage(err)}`);
      return undefined;
    }
  }

  async replyInThread(thread: ThreadRef, text: string): Promise<void> {
    const prRef = this.resolveThreadRef(thread);
    if (!prRef) return;

    try {
      await this.client.postComment(prRef.owner, prRef.repo, prRef.number, text);
    } catch (err) {
      log.warn(`GitHub thread reply failed: ${toErrorMessage(err)}`);
    }
  }

  private resolveThreadRef(thread: ThreadRef): { owner: string; repo: string; number: number } | null {
    // ThreadRef format for GitHub: id = PR number, channel = "github:owner/repo"
    if (!thread.channel.startsWith("github:")) return null;
    const repoFullName = thread.channel.slice(7); // strip "github:"
    const parts = repoFullName.split("/");
    if (parts.length !== 2) return null;
    const prNumber = parseInt(thread.id, 10);
    if (isNaN(prNumber)) return null;
    return { owner: parts[0], repo: parts[1], number: prNumber };
  }
}
