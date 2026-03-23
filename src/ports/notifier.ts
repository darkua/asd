import type { TaskInfo, AIResult, ThreadRef } from "./types.js";

export interface Notifier {
  notifyWorkerStart(): Promise<void>;
  notifyTaskStarted(task: TaskInfo): Promise<ThreadRef | undefined>;
  notifyTaskStatus(thread: ThreadRef, text: string): Promise<void>;
  notifyTaskCompleted(task: TaskInfo, result: AIResult, thread?: ThreadRef): Promise<ThreadRef | undefined>;
  notifyTaskFailed(task: TaskInfo, error: string, thread?: ThreadRef): Promise<ThreadRef | undefined>;
  replyInThread(thread: ThreadRef, text: string): Promise<void>;
}
