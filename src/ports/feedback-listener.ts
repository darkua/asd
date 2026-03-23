import type { RawFeedback } from "./types.js";

export type RawFeedbackHandler = (raw: RawFeedback) => Promise<void>;

export interface FeedbackListener {
  onFeedback(handler: RawFeedbackHandler): void;
  start(): Promise<void>;
  stop(): Promise<void>;
}
