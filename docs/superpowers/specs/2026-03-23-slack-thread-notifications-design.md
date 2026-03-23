# Slack Thread-Based Task Notifications

## Summary

Replace the current post-completion Slack notifications with a thread-based lifecycle system. Each task gets a dedicated thread on the Slack channel, created when work **starts**. All status updates, JIRA links, and results live in that thread. The main message is updated on completion to reflect success/failure.

## Scope

- **Bolt mode only** — webhook mode (`slack.ts` fallback) remains unchanged
- **Moderate detail** — start, JIRA link, key stages (worktree, Claude working, result)
- **English** language for all messages
- **Sequential processing assumed** — one task at a time (MAX subscription rate limits)

## Design

### Main Message (top-level on channel)

Posted when task processing begins:

```
🔧 MP-1182: [AI-GEN] Add footer with copyright
Priority: Medium · Type: Task
```

Updated on completion via `chat.update`:
- Success: `✅ MP-1182: [AI-GEN] Add footer with copyright — Done`
- Failure: `❌ MP-1182: [AI-GEN] Add footer with copyright — Failed`

Includes a `text` fallback field for Slack notifications/accessibility.

### Thread Messages (lifecycle)

Posted in the thread of the main message at key stages:

1. **JIRA link** (immediately after main message):
   `📋 JIRA: https://jira.example.com/browse/MP-1182`

2. **Worktree created**:
   `🔀 Worktree created, starting Claude Code...`

3. **Claude working** (before `runClaudeCode`):
   `🤖 Claude is implementing the task...`

4. **Success result**:
   `✅ PR created: https://github.com/.../pull/123`
   `Duration: 45s` (from `result.durationMs`)

5. **Failure result**:
   `❌ Implementation failed: <error snippet>`

6. **Feedback rounds** — existing behavior unchanged, replies (`fix:`/`redo:`) continue in the same thread.

### Implementation Changes

#### `slack-bot.ts`

Add one new function:

- `updateMessage(channel: string, ts: string, blocks: SlackBlock[]): Promise<void>` — wraps `chat.update` to modify the main message on completion. Catches and logs errors silently (bot may lack `chat:write` scope, or Slack may be down — must not break task processing).

Existing `replyInThread()` is reused for all thread messages.

#### `slack.ts`

Keep `notifySuccess()` and `notifyFailure()` for webhook mode fallback. Add new thread-based functions alongside them:

- `notifyTaskStarted(task: TaskInfo): Promise<{ ts: string; channel: string } | void>` — when Bolt active, posts main message + JIRA link in thread, returns thread info. When Bolt inactive, returns `undefined` (no-op). Wrapped in try/catch — if Slack is down, logs warning and returns `undefined`. Worker continues without a thread.
- `notifyTaskStatus(channel: string, threadTs: string, text: string): Promise<void>` — posts a status update in thread. No-op if `channel`/`threadTs` are falsy or Bolt inactive.
- `notifyTaskCompleted(task: TaskInfo, result: ClaudeResult, channel: string | undefined, threadTs: string | undefined): Promise<{ ts: string; channel: string } | void>` — posts success in thread + updates main message to ✅. Falls back to `notifySuccess()` (webhook) if no thread info. Returns thread info for store persistence.
- `notifyTaskFailed(task: TaskInfo, error: string, channel: string | undefined, threadTs: string | undefined): Promise<{ ts: string; channel: string } | void>` — posts failure in thread + updates main message to ❌. Falls back to `notifyFailure()` (webhook) if no thread info. Returns thread info for store persistence.

All new functions are safe to call regardless of Bolt mode state — they gracefully degrade.

#### `index.ts`

Modified `processTask()` flow:

```
1. Guards (isProcessed, branchExists)
2. markProcessing + setTaskInfo
3. notifyTaskStarted(task)              → posts main msg + JIRA link in thread
4. if threadInfo: setSlackThread(key, ts, channel)  → conditional on step 3 returning info
5. transitionToInProgress(key)          → if this fails, thread shows start but no further progress (acceptable)
6. createWorktree(key)
7. notifyTaskStatus("Worktree created, starting Claude Code...")
8. notifyTaskStatus("Claude is implementing the task...")
9. runClaudeCode(task, workDir)
10. on success → notifyTaskCompleted(task, result, channel, threadTs)
11. on failure → notifyTaskFailed(task, error, channel, threadTs)
```

Thread is created **before** any work starts, so even crashes produce a thread with context. If `notifyTaskStarted` fails (Slack down), processing continues without thread — completion falls back to webhook `notifySuccess`/`notifyFailure`.

Modified `handleFeedback()` flow: uses existing `slackThreadTs`/`slackChannel` from store — feedback replies already go to thread. No changes needed.

#### `store.ts`

No changes. `slackThreadTs` and `slackChannel` are already stored and set earlier in the flow.

### Error Handling

- **Slack down at task start**: `notifyTaskStarted` catches error, returns `undefined`. Worker proceeds without thread. Completion falls back to webhook. **Logs a warning** clearly indicating Bolt failed and webhook fallback is being used (e.g., `"Slack Bolt notification failed, falling back to webhook mode"`), so the operator knows thread-based updates are degraded.
- **`updateMessage` fails**: Caught and logged. Thread messages still show the result — main message just keeps the 🔧 emoji.
- **JIRA transition fails after thread posted**: Thread shows "started" but no further updates until worktree/Claude steps. Acceptable — thread provides visibility into what happened.
- **All Slack calls are non-blocking**: Failures are logged but never prevent task processing.
- **Bolt→webhook fallback visibility**: Any time a Bolt call fails and the system falls back to webhook, a `warn`-level log is emitted with the original error. This applies to `notifyTaskStarted`, `notifyTaskCompleted`, and `notifyTaskFailed`.

### Backward Compatibility

- Webhook mode (`SLACK_WEBHOOK_URL` without bot tokens) continues to work as before — single post-completion message via existing `notifySuccess`/`notifyFailure`.
- Feedback loop in `slack-bot.ts` message handler is unchanged — it already uses threads.
- `notifyWorkerStart()` unchanged.
- If Bolt mode is active but thread creation fails, falls back to webhook behavior.
