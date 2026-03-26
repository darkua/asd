/**
 * Extract a GitHub PR URL from agent output (PR_URL: line or any github.com/.../pull/N URL).
 */
export function extractPrUrlFromOutput(text: string): string | null {
  const prUrlMatch = text.match(/PR_URL:\s*(https:\/\/github\.com\/[^\s]+\/pull\/\d+)/i);
  if (prUrlMatch) return prUrlMatch[1];

  const ghMatch = text.match(/(https:\/\/github\.com\/[^\s]+\/pull\/\d+)/);
  if (ghMatch) return ghMatch[1];

  return null;
}
