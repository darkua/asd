import { readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
import type { Store } from "../../ports/store.js";
import type { TaskInfo, ThreadRef, StoredTask, TaskStatus } from "../../ports/types.js";

interface InternalTask {
  jiraKey: string;
  startedAt: string;
  completedAt?: string;
  status: TaskStatus;
  prUrl?: string;
  error?: string;
  threadId?: string;
  threadChannel?: string;
  // Legacy fields from pre-refactor state files
  slackThreadTs?: string;
  slackChannel?: string;
  feedbackRound: number;
  childProcessPid?: number;
  taskInfo?: TaskInfo;
  costUsd?: number;
}

interface State {
  processed: Record<string, InternalTask>;
}

function toStoredTask(t: InternalTask): StoredTask {
  const task: StoredTask = {
    key: t.jiraKey,
    startedAt: t.startedAt,
    completedAt: t.completedAt,
    status: t.status,
    prUrl: t.prUrl,
    error: t.error,
    feedbackRound: t.feedbackRound,
    childProcessPid: t.childProcessPid,
    taskInfo: t.taskInfo,
    costUsd: t.costUsd,
  };
  // Support both new (threadId) and legacy (slackThreadTs) field names
  const tid = t.threadId ?? t.slackThreadTs;
  const tch = t.threadChannel ?? t.slackChannel;
  if (tid !== undefined && tch !== undefined) {
    task.threadRef = { id: tid, channel: tch };
  }
  return task;
}

export class JsonStore implements Store {
  private readonly filePath: string;
  private cache: State | null = null;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  private loadState(): State {
    if (this.cache) return this.cache;

    let state: State;
    if (!existsSync(this.filePath)) {
      state = { processed: {} };
    } else {
      try {
        state = JSON.parse(readFileSync(this.filePath, "utf-8"));
      } catch {
        state = { processed: {} };
      }
    }
    this.cache = state;
    return state;
  }

  private saveState(state: State): void {
    this.cache = state;
    const tmpPath = this.filePath + ".tmp";
    writeFileSync(tmpPath, JSON.stringify(state, null, 2));
    renameSync(tmpPath, this.filePath);
  }

  getTask(key: string): StoredTask | undefined {
    const state = this.loadState();
    const task = state.processed[key];
    return task ? toStoredTask(task) : undefined;
  }

  getTaskByThread(threadId: string): StoredTask | undefined {
    const state = this.loadState();
    const task = Object.values(state.processed).find(
      (t) => t.threadId === threadId || t.slackThreadTs === threadId,
    );
    return task ? toStoredTask(task) : undefined;
  }

  isProcessed(key: string): boolean {
    const state = this.loadState();
    const task = state.processed[key];
    return task?.status === "done" || task?.status === "review" || task?.status === "processing";
  }

  markProcessing(key: string): void {
    const state = this.loadState();
    state.processed[key] = {
      jiraKey: key,
      startedAt: new Date().toISOString(),
      status: "processing",
      feedbackRound: 0,
    };
    this.saveState(state);
  }

  markReview(key: string, prUrl: string): void {
    const state = this.loadState();
    state.processed[key] = {
      ...state.processed[key],
      completedAt: new Date().toISOString(),
      status: "review",
      prUrl,
    };
    this.saveState(state);
  }

  markDone(key: string): void {
    const state = this.loadState();
    if (state.processed[key]) {
      state.processed[key].status = "done";
      state.processed[key].completedAt = new Date().toISOString();
    }
    this.saveState(state);
  }

  markFailed(key: string, error: string): void {
    const state = this.loadState();
    state.processed[key] = {
      ...state.processed[key],
      completedAt: new Date().toISOString(),
      status: "failed",
      error,
    };
    this.saveState(state);
  }

  markReprocessing(key: string): void {
    const state = this.loadState();
    if (state.processed[key]) {
      state.processed[key].status = "processing";
      state.processed[key].startedAt = new Date().toISOString();
      state.processed[key].completedAt = undefined;
      state.processed[key].error = undefined;
      this.saveState(state);
    }
  }

  resetTask(key: string): void {
    const state = this.loadState();
    delete state.processed[key];
    this.saveState(state);
  }

  setThreadRef(key: string, ref: ThreadRef): void {
    const state = this.loadState();
    if (state.processed[key]) {
      state.processed[key].threadId = ref.id;
      state.processed[key].threadChannel = ref.channel;
      this.saveState(state);
    }
  }

  setTaskInfo(key: string, info: TaskInfo): void {
    const state = this.loadState();
    if (state.processed[key]) {
      state.processed[key].taskInfo = info;
      this.saveState(state);
    }
  }

  setChildPid(key: string, pid: number): void {
    const state = this.loadState();
    if (state.processed[key]) {
      state.processed[key].childProcessPid = pid;
      this.saveState(state);
    }
  }

  clearChildPid(key: string): void {
    const state = this.loadState();
    if (state.processed[key]) {
      state.processed[key].childProcessPid = undefined;
      this.saveState(state);
    }
  }

  incrementFeedbackRound(key: string): number {
    const state = this.loadState();
    const task = state.processed[key];
    if (!task) return 0;
    task.feedbackRound = (task.feedbackRound || 0) + 1;
    this.saveState(state);
    return task.feedbackRound;
  }

  setCost(key: string, cost: number): void {
    const state = this.loadState();
    if (state.processed[key]) {
      state.processed[key].costUsd = cost;
      this.saveState(state);
    }
  }

  getTasksByStatus(status: TaskStatus): StoredTask[] {
    const state = this.loadState();
    return Object.values(state.processed)
      .filter((t) => t.status === status)
      .map(toStoredTask);
  }

  getStats(): { total: number; done: number; review: number; failed: number; processing: number } {
    const state = this.loadState();
    const tasks = Object.values(state.processed);
    return {
      total: tasks.length,
      done: tasks.filter((t) => t.status === "done").length,
      review: tasks.filter((t) => t.status === "review").length,
      failed: tasks.filter((t) => t.status === "failed").length,
      processing: tasks.filter((t) => t.status === "processing").length,
    };
  }
}
