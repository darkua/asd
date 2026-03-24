import { STATUS_EMOJI } from "../../constants.js";

export { STATUS_EMOJI };

interface SlackButton {
  type: "button";
  text: { type: "plain_text"; text: string };
  action_id: string;
  value: string;
  style?: "primary" | "danger";
}

export function buildActionButtons(taskKey: string, status: string): SlackButton[] {
  const buttons: SlackButton[] = [
    { type: "button", text: { type: "plain_text", text: "🔧 Fix" }, action_id: "task_fix", value: taskKey, style: "primary" },
    { type: "button", text: { type: "plain_text", text: "🔄 Redo" }, action_id: "task_redo", value: taskKey },
    { type: "button", text: { type: "plain_text", text: "📊 Status" }, action_id: "task_status", value: taskKey },
  ];
  if (status === "failed") {
    buttons.push({ type: "button", text: { type: "plain_text", text: "🔁 Retry" }, action_id: "task_retry", value: taskKey });
  }
  buttons.push({ type: "button", text: { type: "plain_text", text: "🛑 Cancel" }, action_id: "task_cancel", value: taskKey, style: "danger" });
  return buttons;
}
