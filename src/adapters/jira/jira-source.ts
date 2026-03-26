import type {
  FetchIssueForManualRunOptions,
  ManualTaskFetchResult,
  TaskSource,
} from "../../ports/task-source.js";
import type { TaskInfo } from "../../ports/types.js";
import { JiraClient } from "./jira-client.js";
import { extractText } from "./adf-parser.js";
import { createLogger } from "../../logger.js";

interface JiraSourceConfig {
  baseUrl: string;
  email: string;
  apiToken: string;
  project: string;
  triggerLabel: string;
  doneStatus: string;
}

interface JiraIssue {
  key: string;
  fields: {
    summary: string;
    description: string | null;
    status: { name: string };
    issuetype: { name: string };
    priority?: { name: string };
    labels: string[];
    project?: { key: string };
  };
}

interface JiraSearchResponse {
  issues: JiraIssue[];
  total: number;
}

export class JiraSource implements TaskSource {
  private client: JiraClient;
  private log = createLogger();

  constructor(private config: JiraSourceConfig) {
    this.client = new JiraClient({
      baseUrl: config.baseUrl,
      email: config.email,
      apiToken: config.apiToken,
    });
  }

  async poll(): Promise<TaskInfo[]> {
    const jql = [
      `project = "${this.config.project}"`,
      `summary ~ "[${this.config.triggerLabel}]"`,
      `status = "To Do"`,
    ].join(" AND ");

    this.log.debug(`Polling JIRA: ${jql}`);

    const data = await this.client.fetch<JiraSearchResponse>("/search/jql", {
      method: "POST",
      body: JSON.stringify({
        jql,
        fields: ["summary", "description", "status", "issuetype", "priority", "labels"],
        maxResults: 10,
      }),
    });

    this.log.info(`Found ${data.issues?.length ?? 0} AI-GEN task(s)`);

    return data.issues.map((issue) => this.toTaskInfo(issue));
  }

  async fetchIssueForManualRun(
    key: string,
    options?: FetchIssueForManualRunOptions,
  ): Promise<ManualTaskFetchResult> {
    try {
      const issue = await this.client.fetch<JiraIssue>(
        `/issue/${encodeURIComponent(key)}?fields=summary,description,status,issuetype,priority,labels,project`,
      );

      const proj = issue.fields.project?.key;
      if (!proj || proj.toUpperCase() !== this.config.project.toUpperCase()) {
        return {
          ok: false,
          reason: `Issue is not in project ${this.config.project} (got ${proj ?? "none"}).`,
        };
      }

      const summary = issue.fields.summary || "";
      const summaryNorm = summary.replace(/\s+/g, "");
      const triggerTag = `[${this.config.triggerLabel}]`;
      const triggerNorm = triggerTag.replace(/\s+/g, "");
      if (!summaryNorm.toLowerCase().includes(triggerNorm.toLowerCase())) {
        return {
          ok: false,
          reason: `Summary must include ${triggerTag} (same trigger as JIRA poll / ${triggerTag} with optional spaces).`,
        };
      }

      const statusName = (issue.fields.status?.name || "").trim();
      const st = statusName.toLowerCase();
      if (!options?.bypassStatusFilter) {
        const allowed = new Set(["to do", "in progress"]);
        if (!allowed.has(st)) {
          return {
            ok: false,
            reason: `Manual run allowed only for status "To Do" or "In progress" (currently: ${statusName || "?"}).`,
          };
        }
      }

      return { ok: true, task: this.toTaskInfo(issue), jiraStatusName: statusName };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.warn(`fetchIssueForManualRun ${key}: ${msg}`);
      return { ok: false, reason: `JIRA request failed: ${msg.slice(0, 200)}` };
    }
  }

  private toTaskInfo(issue: JiraIssue): TaskInfo {
    return {
      key: issue.key,
      summary: issue.fields.summary,
      description: extractText(issue.fields.description),
      issueType: issue.fields.issuetype.name,
      priority: issue.fields.priority?.name || "Medium",
      url: `${this.config.baseUrl}/browse/${issue.key}`,
    };
  }

  async transitionToInProgress(key: string): Promise<void> {
    await this.transitionIssue(key, "In progress");
  }

  async transitionToReview(key: string): Promise<void> {
    await this.transitionIssue(key, this.config.doneStatus);
  }

  async addComment(key: string, body: string): Promise<void> {
    await this.client.fetch(`/issue/${key}/comment`, {
      method: "POST",
      body: JSON.stringify({
        body: {
          version: 1,
          type: "doc",
          content: [{ type: "paragraph", content: [{ type: "text", text: body }] }],
        },
      }),
    });
  }

  private async transitionIssue(key: string, targetStatus: string): Promise<void> {
    try {
      const { transitions } = await this.client.fetch<{
        transitions: Array<{ id: string; name: string }>;
      }>(`/issue/${key}/transitions`);

      const target = transitions.find(
        (t) => t.name.toLowerCase() === targetStatus.toLowerCase(),
      );

      if (!target) {
        this.log.warn(`No transition to "${targetStatus}" available for ${key}`, {
          available: transitions.map((t) => t.name),
        });
        return;
      }

      await this.client.fetch(`/issue/${key}/transitions`, {
        method: "POST",
        body: JSON.stringify({ transition: { id: target.id } }),
      });

      this.log.info(`Transitioned ${key} → ${targetStatus}`);
    } catch (err) {
      this.log.warn(`Failed to transition ${key}: ${err}`);
    }
  }
}
