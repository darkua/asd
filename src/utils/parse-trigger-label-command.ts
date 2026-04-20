/**
 * Parses text after `JIRA_TRIGGER_LABEL` (first token must be issue key or numeric id).
 * Example: `MP-123 only change the README` → key + tail `only change the README`.
 */
export function parseIssueKeyAndOperatorTail(
  afterLabel: string,
  defaultProjectKey: string,
): { issueKey: string; operatorTail: string } | null {
  const parts = afterLabel.trim().split(/\s+/);
  if (parts.length === 0) return null;

  const p0 = parts[0];
  const projectNum = p0.match(/^([a-z][a-z0-9]*)-(\d+)$/i);
  if (projectNum) {
    const issueKey = `${projectNum[1].toUpperCase()}-${projectNum[2]}`;
    const operatorTail = parts.slice(1).join(" ").trim();
    return { issueKey, operatorTail };
  }

  const numOnly = p0.match(/^(\d+)$/);
  if (numOnly) {
    const issueKey = `${defaultProjectKey.toUpperCase()}-${numOnly[1]}`;
    const operatorTail = parts.slice(1).join(" ").trim();
    return { issueKey, operatorTail };
  }

  return null;
}
