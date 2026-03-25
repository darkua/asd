import type {
  FeedbackListener,
  RawFeedbackHandler,
  StatusHandler,
} from "../../ports/feedback-listener.js";

export class CompositeFeedbackListener implements FeedbackListener {
  constructor(private readonly listeners: FeedbackListener[]) {}

  onFeedback(handler: RawFeedbackHandler): void {
    for (const listener of this.listeners) {
      listener.onFeedback(handler);
    }
  }

  onStatusRequest(handler: StatusHandler): void {
    for (const listener of this.listeners) {
      listener.onStatusRequest(handler);
    }
  }

  async start(): Promise<void> {
    await Promise.all(this.listeners.map((l) => l.start()));
  }

  async stop(): Promise<void> {
    await Promise.all(this.listeners.map((l) => l.stop()));
  }
}
