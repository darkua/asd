import type { TaskInfo, AIResult, FeedbackRequest, ProgressEvent } from "./types.js";

export type ProgressCallback = (event: ProgressEvent) => void;

export interface AIProvider {
  run(task: TaskInfo, workDir: string, onProgress?: ProgressCallback): Promise<AIResult>;
  runWithFeedback(task: TaskInfo, workDir: string, feedback: FeedbackRequest, onProgress?: ProgressCallback): Promise<AIResult>;
  kill(pid: number): Promise<void>;
}
