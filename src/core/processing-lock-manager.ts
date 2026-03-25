import { logger } from "../logger.js";
import { toErrorMessage } from "../utils/errors.js";
import type { TaskPipeline } from "./task-pipeline.js";

interface QueuedFeedback {
  taskKey: string;
  feedback: string;
  mode: "fix" | "redo";
  replyFn: (text: string) => Promise<void>;
  onCompleteFn?: (success: boolean) => Promise<void>;
}

export class ProcessingLockManager {
  private locks = new Map<string, Promise<void>>();
  private queue: QueuedFeedback[] = [];

  get activeKeys(): string[] {
    return Array.from(this.locks.keys());
  }

  get queueSize(): number {
    return this.queue.length;
  }

  isLocked(key: string): boolean {
    return this.locks.has(key);
  }

  hasOtherLock(excludeKey: string): boolean {
    for (const lockKey of this.locks.keys()) {
      if (lockKey !== excludeKey) return true;
    }
    return false;
  }

  enqueue(item: QueuedFeedback): void {
    this.queue.push(item);
  }

  async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    let lockResolve!: () => void;
    const lockPromise = new Promise<void>((resolve) => { lockResolve = resolve; });
    this.locks.set(key, lockPromise);

    try {
      return await fn();
    } finally {
      this.locks.delete(key);
      lockResolve();
    }
  }

  async drainQueue(pipeline: TaskPipeline): Promise<void> {
    while (this.queue.length > 0) {
      const item = this.queue.shift()!;
      const { taskKey, feedback, mode, replyFn, onCompleteFn } = item;

      logger.info(`Draining queued feedback for ${taskKey}`);

      let success = false;
      await this.withLock(taskKey, async () => {
        try {
          await pipeline.handleFeedback(taskKey, feedback, mode);
          success = true;
        } catch (err) {
          await replyFn(`Feedback processing failed: ${toErrorMessage(err)}`);
        }
      });

      if (onCompleteFn) {
        await onCompleteFn(success).catch((err) => {
          logger.warn(`onCompleteFn error for ${taskKey}: ${toErrorMessage(err)}`);
        });
      }
    }
  }
}
