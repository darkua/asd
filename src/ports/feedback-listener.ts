import type { RawFeedback, WorkerStatus } from "./types.js";

export type RawFeedbackHandler = (raw: RawFeedback) => Promise<void>;
export type StatusHandler = () => WorkerStatus;

export interface TaskRunRequest {
  issueKey: string;
  replyFn: (text: string) => Promise<void>;
  /** When true (e.g. Slack message includes "retry"), skip JIRA status filters and the worker's "In progress" guard. */
  bypassJiraStatusCheck?: boolean;
  /**
   * Operator-provided instructions: agent uses a short prompt built around this text instead of the default JIRA template.
   * Set from Slack `retry KEY your instructions` or `{JIRA_TRIGGER_LABEL} KEY your instructions`.
   */
  directAgentPrompt?: string;
}

export type TaskRunRequestHandler = (req: TaskRunRequest) => Promise<void>;

export interface FeedbackListener {
  onFeedback(handler: RawFeedbackHandler): void;
  onStatusRequest(handler: StatusHandler): void;
  /** Pasted JIRA browse URL or bare PROJECT-123 — start implementation (optional; Slack only). */
  onTaskRunRequest(handler: TaskRunRequestHandler): void;
  start(): Promise<void>;
  stop(): Promise<void>;
}
