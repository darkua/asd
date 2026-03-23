import { createServer, type Server } from "node:http";
import type { Store } from "../../ports/store.js";
import { createLogger } from "../../logger.js";

const log = createLogger();

export class HealthServer {
  private server: Server | null = null;
  private startTime = Date.now();

  constructor(
    private port: number,
    private store: Store,
  ) {}

  async start(): Promise<void> {
    if (this.port <= 0) return;

    this.server = createServer((req, res) => {
      if (req.method === "GET" && req.url === "/health") {
        const stats = this.store.getStats();
        const body = JSON.stringify({
          status: "ok",
          uptime: Math.round((Date.now() - this.startTime) / 1000),
          tasks: stats,
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(body);
        return;
      }

      res.writeHead(404);
      res.end("Not Found");
    });

    await new Promise<void>((resolve) => {
      this.server!.listen(this.port, () => {
        log.info(`Health check endpoint: http://localhost:${this.port}/health`);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve) => {
      this.server!.close(() => resolve());
    });
    this.server = null;
  }
}
