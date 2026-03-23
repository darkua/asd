/**
 * Extract plain text from JIRA's Atlassian Document Format (ADF).
 * Simple recursive extraction — handles paragraphs, lists, headings.
 */
export function extractText(adf: unknown): string {
  if (!adf || typeof adf !== "object") return "";

  const node = adf as Record<string, unknown>;

  if (node.type === "text" && typeof node.text === "string") {
    return node.text;
  }

  if (Array.isArray(node.content)) {
    return node.content
      .map((child: unknown) => extractText(child))
      .join(node.type === "paragraph" || node.type === "heading" ? "\n" : " ")
      .trim();
  }

  return "";
}
