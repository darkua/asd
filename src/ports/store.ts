import type { TaskInfo, ThreadRef, StoredTask } from "./types.js";

export interface Store {
  getTask(key: string): StoredTask | undefined;
  getTaskByThread(threadId: string): StoredTask | undefined;
  isProcessed(key: string): boolean;
  markProcessing(key: string): void;
  markDone(key: string, prUrl: string): void;
  markFailed(key: string, error: string): void;
  markReprocessing(key: string): void;
  resetTask(key: string): void;
  setThreadRef(key: string, ref: ThreadRef): void;
  setTaskInfo(key: string, info: TaskInfo): void;
  setChildPid(key: string, pid: number): void;
  clearChildPid(key: string): void;
  incrementFeedbackRound(key: string): number;
  setFeedbackClosed(key: string): void;
  setLimitReachedAt(key: string): void;
  resetFeedbackLimit(key: string): void;
  getStats(): { total: number; done: number; failed: number; processing: number };
}
