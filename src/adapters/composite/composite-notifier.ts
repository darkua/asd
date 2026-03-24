import type { Notifier } from "../../ports/notifier.js";
import type { TaskInfo, AIResult, ThreadRef } from "../../ports/types.js";
import { createLogger } from "../../logger.js";
import { toErrorMessage } from "../../utils/errors.js";

const log = createLogger();

/**
 * Combines a primary notifier (whose ThreadRef is authoritative) with
 * secondary notifiers that fire-and-forget.
 */
export class CompositeNotifier implements Notifier {
  constructor(
    private readonly primary: Notifier,
    private readonly secondary: Notifier[],
  ) {}

  async notifyWorkerStart(): Promise<void> {
    await this.primary.notifyWorkerStart();
    this.fireSecondary((n) => n.notifyWorkerStart());
  }

  async notifyTaskStarted(task: TaskInfo): Promise<ThreadRef | undefined> {
    const ref = await this.primary.notifyTaskStarted(task);
    this.fireSecondary((n) => n.notifyTaskStarted(task));
    return ref;
  }

  async notifyTaskStatus(thread: ThreadRef, text: string): Promise<void> {
    await this.primary.notifyTaskStatus(thread, text);
    this.fireSecondary((n) => n.notifyTaskStatus(thread, text));
  }

  async notifyTaskCompleted(
    task: TaskInfo,
    result: AIResult,
    thread?: ThreadRef,
  ): Promise<ThreadRef | undefined> {
    const ref = await this.primary.notifyTaskCompleted(task, result, thread);
    this.fireSecondary((n) => n.notifyTaskCompleted(task, result, thread));
    return ref;
  }

  async notifyTaskFailed(
    task: TaskInfo,
    error: string,
    thread?: ThreadRef,
  ): Promise<ThreadRef | undefined> {
    const ref = await this.primary.notifyTaskFailed(task, error, thread);
    this.fireSecondary((n) => n.notifyTaskFailed(task, error, thread));
    return ref;
  }

  async replyInThread(thread: ThreadRef, text: string): Promise<void> {
    await this.primary.replyInThread(thread, text);
    this.fireSecondary((n) => n.replyInThread(thread, text));
  }

  private fireSecondary(fn: (n: Notifier) => Promise<unknown>): void {
    for (const notifier of this.secondary) {
      fn(notifier).catch((err) => {
        log.warn(`Secondary notifier failed: ${toErrorMessage(err)}`);
      });
    }
  }
}
