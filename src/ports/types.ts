export interface TaskInfo {
  key: string;
  summary: string;
  description: string;
  issueType: string;
  priority: string;
  url: string;
}

export interface ThreadRef {
  id: string;
  channel: string;
}

export interface AIResult {
  success: boolean;
  result: string;
  prUrl: string | null;
  exitCode: number | null;
  durationMs: number;
  raw: string;
  pid?: number;
  costUsd?: number;
}

export interface FeedbackRequest {
  feedback: string;
  mode: "fix" | "redo";
  round: number;
  maxRounds: number;
}

export interface RawFeedback {
  taskKey: string;
  feedback: string;
  mode: "fix" | "redo";
  replyFn: (text: string) => Promise<void>;
}

export interface StoredTask {
  key: string;
  startedAt: string;
  completedAt?: string;
  status: "processing" | "done" | "failed";
  prUrl?: string;
  error?: string;
  threadRef?: ThreadRef;
  feedbackRound: number;
  feedbackClosed?: boolean;
  childProcessPid?: number;
  limitReachedAt?: string;
  taskInfo?: TaskInfo;
  costUsd?: number;
}

export interface WorkerConfig {
  pollIntervalMs: number;
  maxTurns: number;
  timeoutMs: number;
  maxFeedbackRounds: number;
  maxConcurrent: number;
  isOnce: boolean;
}

export interface ProgressEvent {
  turn: number;
  maxTurns: number;
  type: "thinking" | "tool_use" | "text" | "result";
  detail: string; // e.g. tool name or text snippet
  elapsedMs: number;
}
