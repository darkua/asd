import type { TaskInfo, ThreadRef, StoredTask, TaskStatus } from "./types.js";

// ─── Segregated Interfaces ──────────────────────────────────

export interface TaskQueryStore {
  getTask(key: string): StoredTask | undefined;
  getTaskByThread(threadId: string): StoredTask | undefined;
  isProcessed(key: string): boolean;
  getTasksByStatus(status: TaskStatus): StoredTask[];
  getStats(): { total: number; done: number; review: number; failed: number; processing: number };
}

export interface TaskStateStore {
  markProcessing(key: string): void;
  markReview(key: string, prUrl: string): void;
  markDone(key: string): void;
  markFailed(key: string, error: string): void;
  markReprocessing(key: string): void;
  resetTask(key: string): void;
}

export interface FeedbackStore {
  incrementFeedbackRound(key: string): number;
}

export interface TaskMetadataStore {
  setThreadRef(key: string, ref: ThreadRef): void;
  setTaskInfo(key: string, info: TaskInfo): void;
  setChildPid(key: string, pid: number): void;
  clearChildPid(key: string): void;
  setCost(key: string, cost: number): void;
}

// ─── Composite (backwards-compatible) ───────────────────────

export interface Store extends TaskQueryStore, TaskStateStore, FeedbackStore, TaskMetadataStore {}
