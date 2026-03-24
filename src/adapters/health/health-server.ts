import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import type { Store } from "../../ports/store.js";
import { createLogger } from "../../logger.js";

const log = createLogger();

type RouteHandler = (req: IncomingMessage, res: ServerResponse) => void;

export class HealthServer {
  private server: Server | null = null;
  private startTime = Date.now();
  private readonly routes = new Map<string, RouteHandler>();

  constructor(
    private port: number,
    private store: Store,
  ) {}

  /** Register a handler for POST requests to a path (e.g. "/webhooks/github"). */
  registerRoute(path: string, handler: RouteHandler): void {
    this.routes.set(path, handler);
    log.info(`Registered route: POST ${path}`);
  }

  async start(): Promise<void> {
    if (this.port <= 0) return;

    this.server = createServer((req, res) => {
      // Health check
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

      // Registered routes (POST only)
      if (req.method === "POST" && req.url) {
        const handler = this.routes.get(req.url);
        if (handler) {
          handler(req, res);
          return;
        }
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
