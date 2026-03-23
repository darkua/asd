# JIRA AI Worker

Automate software implementation: JIRA ticket → Claude Code → Pull Request → Slack notification.

Uses **Claude Code MAX subscription** (no API key billing).

## How it works

```
┌──────────┐    poll     ┌──────────┐   spawn    ┌────────────┐
│   JIRA   │ ──────────> │  Worker  │ ────────>  │ Claude Code│
│ (AI-GEN) │             │ (Node.js)│            │  CLI (-p)  │
└──────────┘             └──────────┘            └────────────┘
                              │                        │
                              │   ┌────────────────────┘
                              │   │ stream-json + PR URL
                              v   v
                         ┌──────────┐
                         │  Slack   │  ← reply in thread
                         │  + JIRA  │    to give feedback
                         └──────────┘
```

1. Polls JIRA every 15 min for issues with `[AI-GEN]` in summary, status "To Do"
2. Creates isolated git worktree per task, auto-installs dependencies
3. Runs Claude Code in headless mode with streaming JSON output
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
    claude/           ← AIProvider: spawns Claude Code CLI
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
- **Claude Code CLI** installed and logged in with MAX subscription
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

# 3. Authenticate Claude Code (one time)
claude login

# 4. Verify
claude -p "echo hello" --output-format json

# 5. Make sure no API key is set
unset ANTHROPIC_API_KEY
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
| `CLAUDE_MAX_TURNS` | `100` | Max agent iterations per task |
| `CLAUDE_TIMEOUT_MS` | `600000` | Timeout per task (10 min) |
| `POLL_INTERVAL_MS` | `900000` | Poll interval (15 min) |
| `MAX_CONCURRENT` | `1` | Parallel task processing |
| `HEALTH_PORT` | `0` | Health check HTTP port (0 = disabled) |

### Slack (Optional)

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

## Safety & Security

- **Never auto-merges** — all PRs are created as drafts
- **PR validation** — verifies PR exists via `gh pr view` before marking success
- **Idempotent** — tracks processed tasks, won't re-process
- **Isolated** — each task runs in its own git worktree
- **Sandboxed** — `--allowedTools` whitelist limits Claude's capabilities
- **Environment sanitized** — Claude child process receives only allowlisted env vars (no JIRA/Slack secrets)
- **Prompt guarded** — system prompt instructs Claude to never read .env or credential files
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
