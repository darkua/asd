// Typed Slack event payloads — replaces `any` casts in listener/notifier

export interface SlackActionPayload {
  actions?: Array<{ value?: string; action_id?: string }>;
  channel?: { id: string };
  message?: { ts: string; thread_ts?: string };
  trigger_id?: string;
}

export interface SlackViewSubmissionPayload {
  private_metadata?: string;
  state?: {
    values?: Record<string, Record<string, { value?: string }>>;
  };
}

export interface SlackMessageEvent {
  ts: string;
  thread_ts?: string;
  text?: string;
  channel: string;
  bot_id?: string;
  subtype?: string;
}
