import type { TaskInfo, FeedbackRequest } from "../../ports/types.js";

export const ALLOWED_TOOLS = [
  "Read", "Write", "Edit", "Glob", "Grep",
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
export function buildPrompt(task: TaskInfo, config: { baseBranch: string }): string {
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
    "2. Read CLAUDE.md for project conventions and architecture rules.",
    "3. Explore the codebase to understand the relevant areas.",
    "4. Implement the changes described in the task.",
    "5. Write or update tests if applicable.",
    "6. Run existing tests to verify nothing is broken: `npm test` or the project's test command.",
    "7. Commit all changes with a conventional commit message: `feat(${task.key}): <concise summary>`.",
    "8. Push the branch to origin.",
    `9. Create a **draft** pull request targeting \`${config.baseBranch}\` with:`,
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
    "Follow CLAUDE.md rules strictly. Do not skip tests.",
    "Do not ask for clarification — make reasonable decisions based on the codebase.",
    "If you encounter a blocker, commit what you have and note the blocker in the PR description.",
    `The git branch is already set up. You are working in the correct directory.`,
    `Push to origin when done. Create the PR using the gh CLI or git commands.`,
  ].join(" ");
}

/**
 * Build the feedback prompt for fix/redo rounds.
 */
export function buildFeedbackPrompt(
  task: TaskInfo,
  feedback: FeedbackRequest,
  config: { baseBranch: string },
): string {
  const originalPrompt = buildPrompt(task, config);

  const instructions =
    feedback.mode === "fix"
      ? [
          "## Instructions",
          "Review the existing implementation on this branch.",
          "Apply the feedback above. Keep existing work and make targeted changes.",
          "Push changes to origin and update the existing PR.",
          "",
          "## Output",
          "After pushing, output EXACTLY this line:",
          "`PR_URL: <the full GitHub PR URL>`",
        ]
      : [
          "## Instructions",
          "Start a fresh implementation from scratch based on the original task and the feedback.",
          `Create a **draft** pull request targeting \`${config.baseBranch}\`.`,
          "",
          "## Output",
          "After completing the PR, output EXACTLY this line:",
          "`PR_URL: <the full GitHub PR URL>`",
        ];

  return [
    originalPrompt,
    "",
    `## Human Feedback (round ${feedback.round} of ${feedback.maxRounds})`,
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
    "Follow CLAUDE.md rules strictly. Do not skip tests.",
    "Do not ask for clarification — apply the feedback as described.",
    mode === "fix"
      ? "You are working on an existing branch with prior implementation. Review what exists and make targeted changes."
      : "You are starting fresh. The branch is clean.",
    "Push to origin when done. Create or update the PR using the gh CLI.",
  ].join(" ");
}
