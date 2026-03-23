import type { TaskInfo, AIResult, FeedbackRequest } from "./types.js";

export interface AIProvider {
  run(task: TaskInfo, workDir: string): Promise<AIResult>;
  runWithFeedback(task: TaskInfo, workDir: string, feedback: FeedbackRequest): Promise<AIResult>;
  kill(pid: number): Promise<void>;
}
