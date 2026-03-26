# JIRA AI Worker

Automate software implementation: JIRA ticket → **Claude Code** or **Cursor Agent CLI** → Pull Request → Slack notification.

- **Claude**: uses **Claude Code MAX** subscription when `ANTHROPIC_API_KEY` is unset.
- **Cursor**: uses **Cursor subscription** via `agent` on PATH (e.g. Cursor CLI login) or optional `CURSOR_API_KEY`.

## How it works

```
┌──────────┐    poll     ┌──────────┐   spawn    ┌────────────┐
│   JIRA   │ ──────────> │  Worker  │ ────────>  │ Claude Code│
│ (AI-GEN) │             │ (Node.js)│     or     │ / Cursor   │
│          │             │          │            │  agent -p  │
└──────────┘             └──────────┘            └────────────┘
                              │                        │
                              │   ┌────────────────────┘
                              │   │ stdout (NDJSON if emitted) + PR URL
                              v   v
                         ┌──────────┐
                         │  Slack   │  ← reply in thread
                         │  + JIRA  │    to give feedback
                         └──────────┘
```

1. Polls JIRA every 15 min for issues with `[AI-GEN]` in summary, status "To Do"
2. Creates isolated git worktree per task, auto-installs dependencies
3. Runs the configured agent (Claude Code with `stream-json`, or Cursor via `sh` + temp prompt file + `agent -p -f --trust "$(cat …)"`) in the worktree cwd
4. Sends real-time progress updates to Slack (every 60s)
5. Validates PR exists via `gh pr view` before marking success
6. Updates JIRA status and notifies Slack with cost + duration summary
7. Reply in the Slack thread to provide feedback, cancel, retry, etc.

## Architecture

Hexagonal (Ports & Adapters) — integrations are swappable:

```
src/
  ports/              ← interfaces (AIProvider, TaskSource, Notifier, Store, VCS)
  core/               ← business logic (TaskPipeline, Worker)
  adapters/
    claude/           ← AIProvider: Claude Code CLI
    cursor/           ← AIProvider: Cursor CLI (prompt file + `sh -c '…cat…'`, cwd = worktree)
    jira/             ← TaskSource: polls JIRA REST API
    slack/            ← Notifier + FeedbackListener: Bolt Socket Mode
    git/              ← VCS: worktree management
    json-store/       ← Store: JSON file persistence (atomic writes)
    health/           ← HTTP health check endpoint
  config/             ← environment config
  index.ts            ← composition root (wires everything)
```

## Prerequisites

- **Node.js 22+**
- **Agent CLI** (pick one per `AGENT_PROVIDER`):
  - **claude** — [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed and `claude login` (MAX subscription; do not set `ANTHROPIC_API_KEY` for MAX billing)
  - **cursor** — [Cursor CLI](https://cursor.com/docs/cli/installation): `agent` on PATH, e.g. `agent about` (or set `CURSOR_API_KEY` if you use API mode)
- **GitHub CLI** (`gh`) authenticated
- **Git** with worktree support
- JIRA Cloud API token

## Setup

```bash
# 1. Install
npm install

# 2. Configure
cp .env.example .env
# Edit .env with your JIRA, repo, and Slack config

# 3. Authenticate the agent (pick one)
# Claude:
claude login
claude -p "echo hello" --output-format json
unset ANTHROPIC_API_KEY   # use MAX subscription, not API key

# Cursor:
# agent about
# agent -p -f --trust "$(cat prompt.txt)"
```

## Usage

```bash
# Continuous polling (production)
npm start

# Single poll cycle (testing)
npm run worker:once

# Development with hot reload
npm run dev

# State management
npm run worker:status          # Show all tracked tasks
npm run worker:reset           # Clear entire state
npm run worker:reset-task -- MP-123  # Reset single task
```

## Creating Tasks for the AI

In JIRA, create a ticket with:
1. **Summary** containing `[AI-GEN]`
2. **Status**: To Do
3. **Description**: Clear, detailed implementation requirements

The worker picks it up on the next poll cycle.

In the **repository under `REPO_PATH`**, keep an **`AGENT.md`** at the root with project conventions (see `AGENT.md.example`). The worker’s prompts tell the agent to read `AGENT.md`.

## Slack Interaction

All task interactions happen through **interactive buttons** — not text commands. Text in task threads is ignored.

### Task Action Buttons

After a task completes or fails, buttons appear in the thread:

| Button | Action |
|--------|--------|
| 🔧 **Fix** | Opens modal — type what should change |
| 🔄 **Redo** | Opens modal — type instructions for fresh implementation |
| 📊 **Status** | Shows task info + re-posts buttons |
| 🔁 **Retry** | Resets failed task (failed tasks only) |
| 🛑 **Cancel** | Kills running task |

While the agent is processing feedback, buttons are replaced with **Cancel only**. Full buttons re-appear when work finishes.

### Channel Commands

Mention the bot (`@YourBot`) or type `status` in the channel to see a task list:

```
Worker Status
Processing: 0 · Review: 2 · Done: 1 · Failed: 0
───────────────
👀 MP-812 — review      [Open]
🔄 MP-1183 — processing [Open]
```

Click **Open** to create a new thread for that task with action buttons.

### Thread Triggers

In a task thread, mention the bot (`@YourBot`) or type `status` to re-post task info + action buttons.

### Task Status Flow

```
processing → review (PR created, under human review)
           → failed
review → processing (Fix/Redo applied)
failed → processing (Retry clicked)
```

## Configuration

### Required

| Variable | Description |
|----------|-------------|
| `JIRA_BASE_URL` | Atlassian instance URL |
| `JIRA_EMAIL` | Your Atlassian email |
| `JIRA_API_TOKEN` | Atlassian API token |
| `JIRA_PROJECT_KEY` | Project key (e.g. MP) |
| `REPO_PATH` | Absolute path to git repo |

### Optional

| Variable | Default | Description |
|----------|---------|-------------|
| `JIRA_TRIGGER_LABEL` | `AI-GEN` | Label to trigger processing |
| `JIRA_DONE_STATUS` | `In Review` | Status after PR creation |
| `REPO_BASE_BRANCH` | `develop` | Base branch for features |
| `AGENT_PROVIDER` | `claude` | `claude` or `cursor` |
| `AGENT_MAX_TURNS` | `100` | Max agent iterations per task (also: `CLAUDE_MAX_TURNS`) |
| `AGENT_TIMEOUT_MS` | `600000` | Timeout per task / child process (10 min; also: `CLAUDE_TIMEOUT_MS`) |
| `CURSOR_AGENT_BIN` | `agent` | Cursor CLI binary (PATH or full path); worker writes prompt to a temp file and runs it via `sh` like `$(cat file)` with cwd = worktree |
| `CURSOR_AGENT_PATH_PREPEND` | (unset) | Prepended to child `PATH` if `agent` is missing from the worker’s PATH (e.g. `/opt/homebrew/bin`) |
| `CURSOR_AGENT_INHERIT_ENV` | `false` | If `true`, child gets full `process.env` (closest to your terminal; forwards worker secrets too) |
| `POLL_INTERVAL_MS` | `900000` | Poll interval (15 min) |
| `MAX_CONCURRENT` | `1` | Parallel task processing |
| `HEALTH_PORT` | `0` | Health check HTTP port (0 = disabled) |

### Slack

#### Webhook only (one-way notifications)

Set `SLACK_WEBHOOK_URL` to receive notifications when tasks complete or fail.

#### Full bidirectional (feedback via threads)

1. Create a Slack App at [api.slack.com/apps](https://api.slack.com/apps)
2. Enable **Socket Mode** → create App-Level Token with `connections:write` scope
3. Add **Bot Token Scopes**: `chat:write`, `channels:history`, `channels:read`
4. Enable **Event Subscriptions** → Subscribe to bot events: `message.channels` (public) or `message.groups` (private)
5. Install the app to your workspace

| Variable | Description |
|----------|-------------|
| `SLACK_BOT_TOKEN` | Bot User OAuth Token (`xoxb-...`) |
| `SLACK_APP_TOKEN` | App-Level Token (`xapp-...`) |
| `SLACK_CHANNEL` | Channel ID for notifications |
| `MAX_FEEDBACK_ROUNDS` | Max rounds before asking to continue (default: 3) |

In any channel thread (or top-level message), you can also type **`retry MP-571`**, **`retry mp-571`**, or **`retry 571`** (numeric suffix uses `JIRA_PROJECT_KEY`). Same behavior as the **Retry** button (failed tasks only). Typo **`retyr`** is accepted.

**Start work from a JIRA link:** paste your issue URL matching `JIRA_BASE_URL`, e.g. `https://your-org.atlassian.net/browse/MP-571` (or a message that is only `MP-571`). The worker loads the issue, checks it matches **project**, **`[JIRA_TRIGGER_LABEL]`** in summary, and status **To Do** or **In progress**. If the task **failed** or a **feature branch** still exists, it clears worker state and git like **Retry**, then starts **`processTask`** immediately (no need to wait for the next poll).

## Safety & Security

- **Never auto-merges** — all PRs are created as drafts
- **PR validation** — verifies PR exists via `gh pr view` before marking success
- **Idempotent** — tracks processed tasks, won't re-process
- **Isolated** — each task runs in its own git worktree
- **Sandboxed (Claude)** — `--allowedTools` whitelist limits Claude Code capabilities
- **Cursor** — writes prompt to `tmpdir`, runs `/bin/sh -c '"$CURSOR_AGENT_BIN" -p -f --trust "$(cat "$CURSOR_PROMPT_FILE")"'` (`CURSOR_AGENT_BIN`); wall-clock cap is Node spawn `AGENT_TIMEOUT_MS`
- **Environment sanitized** — child process receives only allowlisted env vars (no JIRA/Slack secrets)
- **Prompt guarded** — system instructions tell the agent to never read .env or credential files
- **Crash recovery** — stuck "processing" tasks are auto-recovered on restart
- **Atomic state** — state file uses write-to-tmp-then-rename (no corruption on crash)
- **Auto-cleanup** — stale worktrees older than 7 days are automatically removed
- **Cost tracking** — per-task cost logged and shown in Slack notifications

## Health Check

Enable with `HEALTH_PORT=9090`:

```bash
curl http://localhost:9090/health
# {"status":"ok","uptime":3600,"tasks":{"total":5,"done":3,"failed":1,"processing":1}}
```

## Troubleshooting

**Claude uses API key instead of MAX:**
```bash
unset ANTHROPIC_API_KEY
claude login
```

**Cursor Agent not found / works in terminal but fails in worker:**
- The worker used to pass a **small env** (unlike your login shell). It now forwards every `CURSOR_*` variable and logs `command -v` + PATH preview — check that line in logs.
- If logs show `(not found)` for `agent`, set `CURSOR_AGENT_PATH_PREPEND=/opt/homebrew/bin` (or wherever `which agent` points) or set `CURSOR_AGENT_BIN` to the absolute path.
- **TTY:** the child has **no terminal** (`stdio` pipes, `detached` process group). If the CLI still misbehaves only under the worker, try `CURSOR_AGENT_INHERIT_ENV=true` (passes full `process.env`, including secrets from the worker `.env` — use with care).

**Debug the same spawn locally** (any worktree + prompt file):

```bash
npm run cursor:debug -- /path/to/.worktrees/mp-571 /path/to/prompt.txt
# Flags: --inherit-env --path-prepend /opt/homebrew/bin --stdio inherit --attached
```

**Slack feedback not working:**
- Check `SLACK_CHANNEL` is set (Channel ID, not name)
- Verify Event Subscriptions are enabled (`message.channels` or `message.groups`)
- Check logs for `Slack event received:` messages — if missing, events aren't arriving
- After adding scopes/events, **reinstall the app** in your workspace

**Task not picked up after reset:**
- Branch may still exist: `git branch -D feat/mp-xxx && git push origin --delete feat/mp-xxx`

**"No transition available" warnings:**
Your JIRA workflow uses different status names. Update `JIRA_DONE_STATUS` in `.env`.

**Worktree conflicts:**
```bash
git worktree prune
rm -rf /path/to/repo/../.worktrees/
```

**Logs growing too large:**
Log rotation is automatic (10MB max, keeps 3 archives). Or use system-level `logrotate`.
