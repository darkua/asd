interface JiraClientConfig {
  baseUrl: string;
  email: string;
  apiToken: string;
}

export class JiraClient {
  constructor(private config: JiraClientConfig) {}

  private authHeader(): string {
    return "Basic " + Buffer.from(`${this.config.email}:${this.config.apiToken}`).toString("base64");
  }

  async fetch<T>(path: string, options: RequestInit = {}): Promise<T> {
    const url = `${this.config.baseUrl}/rest/api/3${path}`;
    const response = await fetch(url, {
      ...options,
      headers: {
        Authorization: this.authHeader(),
        "Content-Type": "application/json",
        Accept: "application/json",
        ...options.headers,
      },
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`JIRA API ${response.status}: ${body}`);
    }

    const text = await response.text();
    if (!text) return undefined as T;
    return JSON.parse(text) as T;
  }
}
