// Typed Claude CLI stream events — replaces `any` in processStreamEvent

export interface ContentBlockText {
  type: "text";
  text: string;
}

export interface ContentBlockThinking {
  type: "thinking";
  thinking: string;
}

export interface ContentBlockToolUse {
  type: "tool_use";
  name: string;
  input: unknown;
}

export type ContentBlock = ContentBlockText | ContentBlockThinking | ContentBlockToolUse;

export interface AssistantStreamEvent {
  type: "assistant";
  message: {
    content: ContentBlock[];
  };
}

export interface ResultStreamEvent {
  type: "result";
  result?: string;
  stop_reason?: string;
  num_turns?: number;
  total_cost_usd?: number;
}

export type ClaudeStreamEvent = AssistantStreamEvent | ResultStreamEvent;
