import { createLogger } from "../logger.js";

const log = createLogger();

export interface ParsedRetryChannelMessage {
  key: string;
  /** Text after the ticket key — forwarded as `directAgentPrompt` when non-empty. */
  operatorTail?: string;
}

function parseRetryRestAsBrowseUrl(
  rest: string,
  jiraBaseUrl: string,
): ParsedRetryChannelMessage | null {
  const normalizedBase = jiraBaseUrl.replace(/\/$/, "");
  const escaped = normalizedBase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const reBrowse = new RegExp(`${escaped}/browse/([A-Za-z][A-Za-z0-9]*-\\d+)`, "i");
  const m = rest.match(reBrowse);
  if (!m || m.index === undefined) return null;
  const key = m[1].toUpperCase();
  const tail = rest.slice(m.index + m[0].length).trim() || undefined;
  return { key, operatorTail: tail };
}

/**
 * Parse channel text like "retry mp-571", "retry 571 …", `retry https://…/browse/MP-1 …`.
 * Accepts common typo "retyr". Strips a leading Slack user mention (`<@U…>`).
 * Pass `jiraBaseUrl` (same as `JIRA_BASE_URL`) so browse URLs are recognized.
 */
export function parseRetryChannelMessage(
  raw: string,
  defaultProjectKey: string,
  jiraBaseUrl?: string,
): ParsedRetryChannelMessage | null {
  let text = raw.replace(/\s+/g, " ").trim();
  const beforeMentionStrip = text;
  text = text.replace(/^<@[A-Z0-9]+>\s*/i, "").trim();

  const lower = text.toLowerCase();
  const prefix = lower.match(/^(retry|retyr)\s+/i);
  if (!prefix) {
    if (/\bretry\b/i.test(text) || /\bretyr\b/i.test(text)) {
      log.debug(
        `parseRetryChannelMessage: contains retry/retyr but no leading verb after trim; ` +
          `raw=${JSON.stringify(raw.slice(0, 240))} normalized=${JSON.stringify(text.slice(0, 240))}`,
      );
    }
    return null;
  }

  if (beforeMentionStrip !== text) {
    log.debug(
      `parseRetryChannelMessage: stripped leading Slack mention; working text=${JSON.stringify(text.slice(0, 200))}`,
    );
  }

  const rest = text.slice(prefix[0].length).trim();
  if (!rest) {
    log.info(`parseRetryChannelMessage: retry prefix but empty ticket; text=${JSON.stringify(text.slice(0, 200))}`);
    return null;
  }

  const projectTail = rest.match(/^([a-z][a-z0-9]*)-(\d+)(?:\s+(.*))?$/i);
  if (projectTail) {
    const key = `${projectTail[1].toUpperCase()}-${projectTail[2]}`;
    const tail = (projectTail[3] ?? "").trim() || undefined;
    log.info(`parseRetryChannelMessage: matched project-issue → ${key}${tail ? " (with operator tail)" : ""}`);
    return { key, operatorTail: tail };
  }

  const numTail = rest.match(/^(\d+)(?:\s+(.*))?$/);
  if (numTail) {
    const key = `${defaultProjectKey.toUpperCase()}-${numTail[1]}`;
    const tail = (numTail[2] ?? "").trim() || undefined;
    log.info(
      `parseRetryChannelMessage: matched number-only → ${key} (project=${defaultProjectKey})` +
        (tail ? " (with operator tail)" : ""),
    );
    return { key, operatorTail: tail };
  }

  const base = jiraBaseUrl?.trim();
  if (base) {
    const fromUrl = parseRetryRestAsBrowseUrl(rest, base);
    if (fromUrl) {
      log.info(
        `parseRetryChannelMessage: matched JIRA browse URL → ${fromUrl.key}` +
          (fromUrl.operatorTail ? " (with operator tail)" : ""),
      );
      return fromUrl;
    }
  }

  log.info(
    `parseRetryChannelMessage: retry prefix but rest is not PROJECT-NUM or digits; ` +
      `rest=${JSON.stringify(rest.slice(0, 80))} text=${JSON.stringify(text.slice(0, 200))}`,
  );
  return null;
}
