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
}
