import type { TaskInfo } from "./types.js";

export interface TaskSource {
  poll(): Promise<TaskInfo[]>;
  transitionToInProgress(key: string): Promise<void>;
  transitionToReview(key: string): Promise<void>;
  addComment(key: string, body: string): Promise<void>;
}
