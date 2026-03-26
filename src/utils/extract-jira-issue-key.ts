/**
 * Extract issue key from JIRA browse URL (must match `expectedBaseUrl`) or bare `PROJECT-123` for `defaultProjectKey`.
 */
export function extractJiraIssueKeyFromText(
  raw: string,
  expectedBaseUrl: string,
  defaultProjectKey: string,
): string | null {
  const text = raw.trim();
  const normalizedBase = expectedBaseUrl.replace(/\/$/, "");
  const escaped = normalizedBase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const reBrowse = new RegExp(`${escaped}/browse/([A-Za-z][A-Za-z0-9]*-\\d+)`, "i");
  const urlMatch = text.match(reBrowse);
  if (urlMatch) {
    return urlMatch[1].toUpperCase();
  }

  const p = defaultProjectKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const reBareOnly = new RegExp(`^\\s*(${p})-(\\d+)\\s*$`, "i");
  const bare = text.match(reBareOnly);
  if (bare) {
    return `${bare[1].toUpperCase()}-${bare[2]}`;
  }

  return null;
}
