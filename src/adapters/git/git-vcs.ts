import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import type { VCS } from "../../ports/vcs.js";
import { createLogger } from "../../logger.js";

interface GitConfig {
  path: string;
  baseBranch: string;
  remote: string;
}

export class GitVCS implements VCS {
  constructor(private config: GitConfig) {}

  private git(cmd: string, cwd?: string): string {
    return execSync(`git ${cmd}`, {
      cwd: cwd || this.config.path,
      encoding: "utf-8",
      timeout: 30_000,
    }).trim();
  }

  branchName(key: string): string {
    return `feat/${key.toLowerCase()}`;
  }

  worktreePath(key: string): string {
    return join(dirname(this.config.path), ".worktrees", key.toLowerCase());
  }

  branchExists(key: string): boolean {
    const branch = this.branchName(key);
    try {
      const refs = this.git(`branch -a --list *${branch}`);
      return refs.length > 0;
    } catch {
      return false;
    }
  }

  createWorktree(key: string): string {
    const log = createLogger(key);
    const branch = this.branchName(key);
    const wPath = this.worktreePath(key);

    this.git(`fetch ${this.config.remote} ${this.config.baseBranch} --prune`);

    if (existsSync(wPath)) {
      log.warn("Stale worktree found, removing");
      try {
        this.git(`worktree remove "${wPath}" --force`);
      } catch {
        execSync(`rm -rf "${wPath}"`, { encoding: "utf-8" });
        this.git("worktree prune");
      }
    }

    try {
      this.git(`branch -D ${branch} 2>/dev/null`);
    } catch {
      // branch doesn't exist locally
    }

    this.git(
      `worktree add "${wPath}" -b ${branch} ${this.config.remote}/${this.config.baseBranch}`
    );

    log.info(`Created worktree at ${wPath} on branch ${branch}`);

    // Install dependencies based on detected package manager
    this.installDependencies(wPath, log);

    return wPath;
  }

  removeWorktree(key: string): void {
    const log = createLogger(key);
    const wPath = this.worktreePath(key);

    try {
      if (existsSync(wPath)) {
        this.git(`worktree remove "${wPath}" --force`);
        log.debug("Worktree removed");
      }
    } catch (err) {
      log.warn(`Worktree cleanup failed: ${err}`);
      try {
        execSync(`rm -rf "${wPath}"`, { encoding: "utf-8" });
        this.git("worktree prune");
      } catch {
        // nothing more we can do
      }
    }
  }

  closePR(key: string): void {
    const log = createLogger(key);
    try {
      execSync(
        `gh pr close ${this.branchName(key)} --delete-branch`,
        { cwd: this.config.path, encoding: "utf-8", stdio: "pipe" },
      );
    } catch {
      log.debug("No existing PR to close or gh CLI unavailable");
    }
  }

  async validatePrUrl(url: string): Promise<boolean> {
    const log = createLogger();
    try {
      execSync(`gh pr view "${url}" --json state`, {
        cwd: this.config.path,
        encoding: "utf-8",
        stdio: "pipe",
        timeout: 15_000,
      });
      return true;
    } catch {
      log.warn(`PR validation failed for ${url}`);
      return false;
    }
  }

  ensureReady(): void {
    const log = createLogger();
    try {
      this.git("rev-parse --git-dir");
    } catch {
      throw new Error(`${this.config.path} is not a git repository`);
    }
    this.git("worktree prune");
    log.debug("Repo ready");
  }

  private installDependencies(workDir: string, log: ReturnType<typeof createLogger>): void {
    // Detect package manager by lock file
    let cmd: string;
    if (existsSync(join(workDir, "pnpm-lock.yaml"))) {
      cmd = "pnpm install --frozen-lockfile";
    } else if (existsSync(join(workDir, "yarn.lock"))) {
      cmd = "yarn install --frozen-lockfile";
    } else if (existsSync(join(workDir, "bun.lockb")) || existsSync(join(workDir, "bun.lock"))) {
      cmd = "bun install --frozen-lockfile";
    } else if (existsSync(join(workDir, "package-lock.json"))) {
      cmd = "npm ci";
    } else if (existsSync(join(workDir, "package.json"))) {
      cmd = "npm install";
    } else {
      log.debug("No package.json found, skipping dependency install");
      return;
    }

    log.info(`Installing dependencies: ${cmd}`);
    try {
      execSync(cmd, {
        cwd: workDir,
        encoding: "utf-8",
        stdio: "pipe",
        timeout: 300_000, // 5 min
      });
      log.info("Dependencies installed");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`Dependency install failed: ${msg.slice(0, 200)}`);
    }
  }
}
