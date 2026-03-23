import type { RawFeedback, WorkerStatus } from "./types.js";

export type RawFeedbackHandler = (raw: RawFeedback) => Promise<void>;
export type StatusHandler = () => WorkerStatus;

export interface FeedbackListener {
  onFeedback(handler: RawFeedbackHandler): void;
  onStatusRequest(handler: StatusHandler): void;
  start(): Promise<void>;
  stop(): Promise<void>;
}
