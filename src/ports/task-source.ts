import type { TaskInfo } from "./types.js";

export type ManualTaskFetchResult =
  | { ok: true; task: TaskInfo; jiraStatusName: string }
  | { ok: false; reason: string };

export type FetchIssueForManualRunOptions = {
  /** Skip "To Do" / "In progress" only constraint — use for explicit Slack retry messages. */
  bypassStatusFilter?: boolean;
};

export interface TaskSource {
  poll(): Promise<TaskInfo[]>;
  /** Load one issue for Slack/manual trigger (validates project, trigger tag; status unless bypassed). */
  fetchIssueForManualRun(
    key: string,
    options?: FetchIssueForManualRunOptions,
  ): Promise<ManualTaskFetchResult>;
  transitionToInProgress(key: string): Promise<void>;
  transitionToReview(key: string): Promise<void>;
  addComment(key: string, body: string): Promise<void>;
}
