/**
 * Cursor Agent CLI NDJSON events when the CLI emits JSON lines on stdout (optional; worker still parses line-by-line).
 * @see https://cursor.com/docs/cli/reference/output-format.md
 */

export interface CursorSystemInitEvent {
  type: "system";
  subtype: "init";
  model?: string;
  session_id?: string;
  cwd?: string;
}

export interface CursorUserEvent {
  type: "user";
  message?: {
    role: string;
    content?: Array<{ type: string; text?: string }>;
  };
  session_id?: string;
}

export interface CursorAssistantEvent {
  type: "assistant";
  message?: {
    role: string;
    content?: Array<{ type: string; text?: string }>;
  };
  session_id?: string;
}

export interface CursorToolCallEvent {
  type: "tool_call";
  subtype?: "started" | "completed";
  call_id?: string;
  tool_call?: Record<string, unknown>;
  session_id?: string;
}

export interface CursorResultEvent {
  type: "result";
  subtype?: string;
  is_error?: boolean;
  duration_ms?: number;
  duration_api_ms?: number;
  result?: string;
  session_id?: string;
  request_id?: string;
}

export type CursorStreamEvent =
  | CursorSystemInitEvent
  | CursorUserEvent
  | CursorAssistantEvent
  | CursorToolCallEvent
  | CursorResultEvent
  | Record<string, unknown>;
