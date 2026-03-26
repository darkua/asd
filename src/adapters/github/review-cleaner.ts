/**
 * Strips noise from CodeRabbit (and other bot) review bodies/comments.
 *
 * Removes:
 *  - HTML comments (<!-- ... -->)
 *  - <details> blocks: "Prompt for AI Agents", "Review info",
 *    "Prompt for all review comments", "Run configuration",
 *    "Commits", "Files selected"
 *  - Committable suggestion blocks (the raw diff is rarely useful for the agent)
 *  - Severity/label lines that only add visual noise
 *  - Consecutive blank lines (collapsed to single)
 */

/** Regex that matches a `<details>…</details>` block whose <summary> contains a keyword. */
function stripDetailsByKeyword(text: string, keyword: string): string {
  // Non-greedy match for the innermost <details> containing the keyword in its summary.
  // We loop because there can be multiple such blocks.
  const pattern = new RegExp(
    `<details>\\s*<summary>[^<]*${escapeRegex(keyword)}[^<]*</summary>[\\s\\S]*?</details>`,
    "gi",
  );
  return text.replace(pattern, "");
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const NOISE_KEYWORDS = [
  "Prompt for AI Agents",
  "Prompt for all review comments",
  "Review info",
  "Run configuration",
  "Commits",
  "Files selected for processing",
  "Committable suggestion",
];

export function cleanReviewBody(raw: string): string {
  let text = raw;

  // 1. Remove HTML comments  <!-- ... -->
  text = text.replace(/<!--[\s\S]*?-->/g, "");

  // 2. Remove noisy <details> blocks
  for (const keyword of NOISE_KEYWORDS) {
    text = stripDetailsByKeyword(text, keyword);
  }

  // 3. Unwrap useful <details> blocks (Recommended approach, Proposed fix)
  //    Keep content, remove the wrapper tags
  text = text.replace(
    /<details>\s*<summary>([^<]*(?:Recommended approach|Proposed fix)[^<]*)<\/summary>([\s\S]*?)<\/details>/gi,
    (_match, summary: string, content: string) => {
      const cleanSummary = summary.replace(/[🛡️🔧]/g, "").trim();
      return `**${cleanSummary}**\n${content.trim()}`;
    },
  );

  // 4. Remove any remaining empty <details></details> or <blockquote></blockquote>
  text = text.replace(/<details>\s*<\/details>/gi, "");
  text = text.replace(/<blockquote>\s*<\/blockquote>/gi, "");

  // 5. Remove severity/label lines like "_⚠️ Potential issue_ | _🟡 Minor_"
  text = text.replace(/^_[⚠️🟡🟠🔴🟢]+\s*[^_]*_\s*\|\s*_[^_]*_\s*$/gm, "");

  // 6. Remove standalone emoji-only lines (leftover separators)
  text = text.replace(/^\s*---\s*$/gm, "");

  // 7. Collapse multiple blank lines to one
  text = text.replace(/\n{3,}/g, "\n\n");

  return text.trim();
}

/**
 * Clean an individual review comment body (line-level comments).
 * These are usually shorter but can still contain AI prompts and HTML noise.
 */
export function cleanCommentBody(raw: string): string {
  return cleanReviewBody(raw);
}
