## 1.0.2

### Patch Changes

- feat: Add `AGENT_MODEL` override support for both Claude and Cursor providers, including runtime logging for requested and effective model.
- feat: Add `BRANCH_DRAFT` configuration to control whether agent-created PRs are draft or regular.
- fix: Restrict GitHub comment-triggered runs to `@<botUsername>` mentions or CodeRabbit comments only.
- feat: Include clickable latest commit SHA links in review-comment completion replies.
- chore: Update feedback-round changelog guidance to append lines to an existing task entry instead of creating a new patch/version entry each time.

## 1.0.1

### Patch Changes

- feat: Add Cursor Agent execution path with dedicated provider, shell wrapper, stream parsing, and prompt plumbing.
- feat: Support manual task start from Slack JIRA link/key messages, including retry text parsing and explicit retry status-check bypass.
- feat: Add GitHub webhook listener/notifier wiring with composite feedback/notifier support alongside Slack.
- chore: Rename agent guidance files to AGENT, expand env/config for new integrations, and add cursor debug tooling.
