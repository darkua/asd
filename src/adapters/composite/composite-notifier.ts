import type { Notifier } from "../../ports/notifier.js";
import type { TaskInfo, AIResult, ThreadRef } from "../../ports/types.js";
import { createLogger } from "../../logger.js";
import { toErrorMessage } from "../../utils/errors.js";

const log = createLogger();

/**
 * Builds a lookup key for a ThreadRef (channel:id).
 */
function threadKey(ref: ThreadRef): string {
  return `${ref.channel}:${ref.id}`;
}

/**
 * Combines multiple notifiers, preserving per-channel ThreadRef context
 * so each notifier receives its own thread reference for status updates.
 *
 * The primary notifier's ThreadRef is authoritative (returned to callers).
 * Secondary notifiers' ThreadRefs are collected and stored internally so
 * that notifyTaskStatus/replyInThread can forward the correct ref.
 */
export class CompositeNotifier implements Notifier {
  /**
   * Maps primary thread key → per-notifier ThreadRef.
   * Key: `${primaryRef.channel}:${primaryRef.id}`
   * Value: Map<notifierIndex, ThreadRef> (index into this.secondary)
   */
  private readonly channelThreads = new Map<string, Map<number, ThreadRef>>();

  constructor(
    private readonly primary: Notifier,
    private readonly secondary: Notifier[],
  ) {}

  async notifyWorkerStart(): Promise<void> {
    await this.primary.notifyWorkerStart();
    for (const notifier of this.secondary) {
      notifier.notifyWorkerStart().catch((err) => {
        log.warn(`Secondary notifier failed: ${toErrorMessage(err)}`);
      });
    }
  }

  async notifyTaskStarted(task: TaskInfo): Promise<ThreadRef | undefined> {
    const primaryRef = await this.primary.notifyTaskStarted(task);
    // Await secondary refs to capture per-channel threads
    this.collectSecondaryRefs(
      primaryRef,
      (n) => n.notifyTaskStarted(task),
    );
    return primaryRef;
  }

  async notifyTaskStatus(thread: ThreadRef, text: string): Promise<void> {
    await this.primary.notifyTaskStatus(thread, text);

    const key = threadKey(thread);
    const secondaryRefs = this.channelThreads.get(key);

    for (let i = 0; i < this.secondary.length; i++) {
      const ref = secondaryRefs?.get(i);
      if (ref) {
        this.secondary[i].notifyTaskStatus(ref, text).catch((err) => {
          log.warn(`Secondary notifier status failed: ${toErrorMessage(err)}`);
        });
      }
      // If no ref stored for this secondary, skip — it hasn't produced one yet
    }
  }

  async notifyTaskCompleted(
    task: TaskInfo,
    result: AIResult,
    thread?: ThreadRef,
  ): Promise<ThreadRef | undefined> {
    const primaryRef = await this.primary.notifyTaskCompleted(task, result, thread);
    this.collectSecondaryRefs(
      thread ?? primaryRef,
      (n) => n.notifyTaskCompleted(task, result, thread),
    );
    return primaryRef;
  }

  async notifyTaskFailed(
    task: TaskInfo,
    error: string,
    thread?: ThreadRef,
  ): Promise<ThreadRef | undefined> {
    const primaryRef = await this.primary.notifyTaskFailed(task, error, thread);
    this.collectSecondaryRefs(
      thread ?? primaryRef,
      (n) => n.notifyTaskFailed(task, error, thread),
    );
    return primaryRef;
  }

  async replyInThread(thread: ThreadRef, text: string): Promise<void> {
    await this.primary.replyInThread(thread, text);

    const key = threadKey(thread);
    const secondaryRefs = this.channelThreads.get(key);

    for (let i = 0; i < this.secondary.length; i++) {
      const ref = secondaryRefs?.get(i);
      if (ref) {
        this.secondary[i].replyInThread(ref, text).catch((err) => {
          log.warn(`Secondary notifier reply failed: ${toErrorMessage(err)}`);
        });
      }
    }
  }

  /**
   * Fire secondary notifiers and store any ThreadRefs they return,
   * keyed by the primary thread ref for later lookup.
   */
  private collectSecondaryRefs(
    primaryRef: ThreadRef | undefined,
    fn: (n: Notifier) => Promise<ThreadRef | undefined>,
  ): void {
    if (!primaryRef) return;

    const key = threadKey(primaryRef);

    for (let i = 0; i < this.secondary.length; i++) {
      const idx = i;
      fn(this.secondary[idx])
        .then((secondaryRef) => {
          if (secondaryRef) {
            let refs = this.channelThreads.get(key);
            if (!refs) {
              refs = new Map();
              this.channelThreads.set(key, refs);
            }
            refs.set(idx, secondaryRef);
          }
        })
        .catch((err) => {
          log.warn(`Secondary notifier failed: ${toErrorMessage(err)}`);
        });
    }
  }
}
