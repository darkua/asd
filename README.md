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
                              │   │ JSON result + PR URL
                              v   v
                         ┌──────────┐
                         │  Slack   │  ← reply in thread
                         │  + JIRA  │    to give feedback
                         └──────────┘
```

1. Polls JIRA every 15 min for issues labeled `AI-GEN` in "To Do"
2. Creates isolated git worktree per task
3. Runs Claude Code in headless mode with streaming JSON output
4. Claude reads CLAUDE.md, implements the task, creates a draft PR
5. Worker updates JIRA status and notifies Slack
6. Reply in the Slack thread to provide feedback — Claude applies it

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
    json-store/       ← Store: JSON file persistence
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
```

## Creating Tasks for the AI

In JIRA, create a ticket with:
1. **Summary** containing `[AI-GEN]`
2. **Status**: To Do
3. **Description**: Clear, detailed implementation requirements

The worker picks it up on the next poll cycle.

## Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `JIRA_BASE_URL` | Yes | — | Atlassian instance URL |
| `JIRA_EMAIL` | Yes | — | Your Atlassian email |
| `JIRA_API_TOKEN` | Yes | — | Atlassian API token |
| `JIRA_PROJECT_KEY` | Yes | — | Project key (e.g. MP) |
| `REPO_PATH` | Yes | — | Absolute path to git repo |
| `JIRA_TRIGGER_LABEL` | No | `AI-GEN` | Label to trigger processing |
| `JIRA_DONE_STATUS` | No | `In Review` | Status after PR creation |
| `REPO_BASE_BRANCH` | No | `develop` | Base branch for features |
| `CLAUDE_MAX_TURNS` | No | `100` | Max agent iterations per task |
| `CLAUDE_TIMEOUT_MS` | No | `600000` | Timeout per task (10 min) |
| `POLL_INTERVAL_MS` | No | `900000` | Poll interval (15 min) |

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

#### Giving Feedback

Reply in the Slack notification thread:
- **Fix mode** (default): `change the button color to blue` or `fix: improve validation`
- **Redo mode**: `redo: start over with a different approach`

After reaching the round limit, reply `tak`/`yes` to continue or `nie`/`no` to stop.

## Safety

- **Never auto-merges** — all PRs are created as drafts
- **Idempotent** — tracks processed tasks, won't re-process
- **Isolated** — each task runs in its own git worktree
- **Sandboxed** — `--allowedTools` whitelist limits Claude's capabilities
- **Rate-limited** — sequential processing respects MAX subscription limits
- **No API key** — uses MAX subscription billing exclusively

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

**"No transition available" warnings:**
Your JIRA workflow uses different status names. Update `JIRA_DONE_STATUS` in `.env`.

**"Found undefined AI-GEN task(s)" in logs:**
Not a real issue — cosmetic, fixed in latest version.

**Worktree conflicts:**
```bash
git worktree prune
rm -rf /path/to/repo/../.worktrees/
```
