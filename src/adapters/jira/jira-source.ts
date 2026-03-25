import type { TaskSource } from "../../ports/task-source.js";
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
      `labels = "${this.config.triggerLabel}"`,
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

    return data.issues.map((issue) => ({
      key: issue.key,
      summary: issue.fields.summary,
      description: extractText(issue.fields.description),
      issueType: issue.fields.issuetype.name,
      priority: issue.fields.priority?.name || "Medium",
      url: `${this.config.baseUrl}/browse/${issue.key}`,
    }));
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
