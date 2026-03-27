import type { TaskInfo, FeedbackRequest } from "../ports/types.js";

export const ALLOWED_TOOLS = [
  "Read",
  "Write",
  "Edit",
  "Glob",
  "Grep",
  "Bash(git:*)",
  "Bash(gh pr create:*)",
  "Bash(gh pr view:*)",
  "Bash(npm:*)",
  "Bash(npx:*)",
  "Bash(yarn:*)",
  "Bash(pnpm:*)",
  "Bash(cat:*)",
  "Bash(ls:*)",
  "Bash(find:*)",
  "Bash(head:*)",
  "Bash(tail:*)",
  "Bash(wc:*)",
  "Bash(mkdir:*)",
  "Bash(cp:*)",
  "Bash(mv:*)",
].join(",");

/**
 * Build the implementation prompt from JIRA task info.
 */
export function buildPrompt(
  task: TaskInfo,
  config: { baseBranch: string; draftPr: boolean },
): string {
  const prKind = config.draftPr ? "draft" : "regular";
  return [
    `## Task: ${task.key}`,
    `**Summary:** ${task.summary}`,
    `**Type:** ${task.issueType} | **Priority:** ${task.priority}`,
    "",
    `**Description:**`,
    task.description || "(no description provided)",
    "",
    "## Instructions",
    "1. Read and understand the task above thoroughly.",
    "2. Read AGENT.md for project conventions and architecture rules.",
    "3. Explore the codebase to understand the relevant areas.",
    "4. Implement the changes described in the task.",
    "5. Write or update tests if applicable.",
    "6. Run existing tests to verify nothing is broken: `npm test` or the project's test command.",
    "7. Update the changelog (repo-aware) BEFORE committing.",
    "   - This is the INITIAL implementation run for this task: create the patch version entry now.",
    "   - Detect changelog tooling by inspecting the repo:",
    "     a) If a `.changeset/` directory exists (and `changeset` CLI seems available):",
    "        i) Look for existing `.changeset/*.md` files and copy the frontmatter/package key format.",
    "        ii) Create a new `.changeset/<id>.md` entry with `patch` and a short summary mentioning this JIRA task.",
    "        iii) Run `npx changeset version` to update changelog/version files. Do not run `publish`.",
    "     b) Else if `CHANGELOG.md` exists:",
    "        i) Detect the existing style/section (e.g. `Unreleased` or top section).",
    "        ii) Add a new bullet/paragraph entry matching the existing format.",
    "     c) Else:",
    "        - Skip changelog updates (do not fail).",
    "8. Commit all changes with a conventional commit message: `feat(${task.key}): <concise summary>`.",
    "9. Push the branch to origin.",
    `10. Create a **${prKind}** pull request targeting \`${config.baseBranch}\` with:`,
    `   - Title: \`${task.key}: ${task.summary}\``,
    `   - Body: summary of changes + link to JIRA ticket: ${task.url}`,
    "",
    "## Output",
    "After completing the PR, output EXACTLY this line:",
    "`PR_URL: <the full GitHub PR URL>`",
  ].join("\n");
}

/**
 * Build the system prompt addendum for the agent.
 */
export function buildSystemPrompt(): string {
  return [
    "You are an autonomous software engineer implementing a JIRA task.",
    "Follow AGENT.md rules strictly. Do not skip tests.",
    "CRITICAL: You are fully autonomous. NEVER ask questions, NEVER ask for confirmation, NEVER ask 'shall I...?' or 'should I...?'. Just do it. Make all decisions yourself.",
    "If you encounter a blocker, commit what you have and note the blocker in the PR description.",
    `The git branch is already set up. You are working in the correct directory.`,
    `Push to origin when done. Create the PR using the gh CLI or git commands.`,
    "Never read .env, .env.*, credentials, or any file containing secrets.",
  ].join(" ");
}

/**
 * Build the feedback prompt for fix/redo rounds.
 */
export function buildFeedbackPrompt(
  task: TaskInfo,
  feedback: FeedbackRequest,
  config: { baseBranch: string; draftPr: boolean },
): string {
  const originalPrompt = buildPrompt(task, config);
  const prKind = config.draftPr ? "draft" : "regular";

  const instructions =
    feedback.mode === "fix"
      ? [
          "## Instructions",
          "Review the existing implementation on this branch.",
          "Apply the feedback above. Keep existing work and make targeted changes.",
          "Update the changelog (repo-aware) BEFORE pushing/committing.",
          "Changelog rule for feedback rounds: DO NOT create a new patch/version entry.",
          "Instead, find the existing changelog entry for this task and append new line(s) under that same entry.",
          "Push changes to origin and update the existing PR.",
          "",
          "## Output",
          "After pushing, output EXACTLY this line:",
          "`PR_URL: <the full GitHub PR URL>`",
        ]
      : [
          "## Instructions",
          "Start a fresh implementation from scratch based on the original task and the feedback.",
          "Update the changelog (repo-aware) BEFORE pushing/committing.",
          "Changelog rule for feedback rounds: DO NOT create a new patch/version entry.",
          "Instead, find the existing changelog entry for this task and append new line(s) under that same entry.",
          `Create a ${prKind} pull request targeting \`${config.baseBranch}\`.`,
          "",
          "## Output",
          "After completing the PR, output EXACTLY this line:",
          "`PR_URL: <the full GitHub PR URL>`",
        ];

  return [
    originalPrompt,
    "",
    `## Human Feedback (round ${feedback.round})`,
    feedback.feedback,
    "",
    ...instructions,
  ].join("\n");
}

/**
 * Build the system prompt for feedback rounds.
 */
export function buildFeedbackSystemPrompt(mode: "fix" | "redo"): string {
  return [
    "You are an autonomous software engineer applying human feedback to a JIRA task implementation.",
    "Follow AGENT.md rules strictly. Do not skip tests.",
    "CRITICAL: You are fully autonomous. NEVER ask questions, NEVER ask for confirmation, NEVER ask 'shall I...?' or 'should I...?'. Just do it. Apply the feedback as described.",
    mode === "fix"
      ? "You are working on an existing branch with prior implementation. Review what exists and make targeted changes."
      : "You are starting fresh. The branch is clean.",
    "Push to origin when done. Create or update the PR using the gh CLI.",
    "Before pushing/committing, update the changelog using the repo's existing changelog tooling (Changesets if present, otherwise CHANGELOG.md style if present).",
    "For feedback rounds, never bump version/create a new patch entry again; only append lines to the existing task entry.",
    "Never read .env, .env.*, credentials, or any file containing secrets.",
  ].join(" ");
}

/**
 * Cursor Agent CLI has no --append-system-prompt; fold system text + limits into the user message.
 */
export function buildCursorCombinedPrompt(
  systemPrompt: string,
  taskPrompt: string,
  limits: { maxTurns: number; timeoutMs: number; draftPr: boolean },
): string {
  const prGuidance = limits.draftPr ? "prefer shipping a draft PR" : "prefer shipping a PR";
  return [
    "## System instructions",
    systemPrompt,
    "",
    "## Operational limits (enforced by the worker)",
    `- Complete the task in at most approximately ${limits.maxTurns} agent steps (tool-using iterations); ${prGuidance} over unbounded work.`,
    `- The worker will send SIGTERM to this process after ${limits.timeoutMs} ms wall-clock; finish or save progress before then.`,
    "",
    "---",
    "",
    "## Task",
    taskPrompt,
  ].join("\n");
}
