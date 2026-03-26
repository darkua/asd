import { createLogger } from "../logger.js";

const log = createLogger();

/**
 * Parse channel text like "retry mp-571", "retry 571", "retry MP-571".
 * Accepts common typo "retyr". Strips a leading Slack user mention (`<@U…>`).
 * Returns normalized JIRA key (e.g. MP-571).
 */
export function parseRetryTicketKey(raw: string, defaultProjectKey: string): string | null {
  let text = raw.replace(/\s+/g, " ").trim();
  const beforeMentionStrip = text;
  text = text.replace(/^<@[A-Z0-9]+>\s*/i, "").trim();

  const lower = text.toLowerCase();
  const prefix = lower.match(/^(retry|retyr)\s+/i);
  if (!prefix) {
    if (/\bretry\b/i.test(text) || /\bretyr\b/i.test(text)) {
      log.debug(
        `parseRetryTicketKey: contains retry/retyr but no leading verb after trim; ` +
          `raw=${JSON.stringify(raw.slice(0, 240))} normalized=${JSON.stringify(text.slice(0, 240))}`,
      );
    }
    return null;
  }

  if (beforeMentionStrip !== text) {
    log.debug(`parseRetryTicketKey: stripped leading Slack mention; working text=${JSON.stringify(text.slice(0, 200))}`);
  }

  const rest = text.slice(prefix[0].length).trim();
  if (!rest) {
    log.info(`parseRetryTicketKey: retry prefix but empty ticket; text=${JSON.stringify(text.slice(0, 200))}`);
    return null;
  }

  const projectNum = rest.match(/^([a-z][a-z0-9]*)-(\d+)$/i);
  if (projectNum) {
    const key = `${projectNum[1].toUpperCase()}-${projectNum[2]}`;
    log.info(`parseRetryTicketKey: matched project-issue → ${key}`);
    return key;
  }

  const numOnly = rest.match(/^(\d+)$/);
  if (numOnly) {
    const key = `${defaultProjectKey.toUpperCase()}-${numOnly[1]}`;
    log.info(`parseRetryTicketKey: matched number-only → ${key} (project=${defaultProjectKey})`);
    return key;
  }

  log.info(
    `parseRetryTicketKey: retry prefix but rest is not PROJECT-NUM or digits; ` +
      `rest=${JSON.stringify(rest.slice(0, 80))} text=${JSON.stringify(text.slice(0, 200))}`,
  );
  return null;
}
