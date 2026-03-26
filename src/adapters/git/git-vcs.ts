import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, dirname, resolve, relative, isAbsolute } from "node:path";
import type { VCS } from "../../ports/vcs.js";
import { createLogger } from "../../logger.js";
import { GIT_TIMEOUT_MS, INSTALL_TIMEOUT_MS } from "../../constants.js";
import { toErrorMessage } from "../../utils/errors.js";

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
      timeout: GIT_TIMEOUT_MS,
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

  /** True if `p` is this repo's shared `.worktrees` directory or a path inside it. */
  private isUnderProjectWorktrees(p: string): boolean {
    const root = resolve(dirname(this.config.path), ".worktrees");
    const rel = relative(root, resolve(p));
    if (rel === "") return true;
    if (isAbsolute(rel)) return false;
    return !rel.startsWith("..");
  }

  /**
   * Drop any git registration for this ticket's worktree path or feature branch.
   * Needed when the folder was deleted manually but git still locks the branch, or
   * when a previous remove failed — otherwise `worktree add -b` errors with
   * "already checked out at ...".
   */
  private releaseTicketGitSlot(wPath: string, branch: string, log: ReturnType<typeof createLogger>): void {
    const target = resolve(wPath);
    let removed = false;

    try {
      const porcelain = this.git("worktree list --porcelain");
      const blocks = porcelain.split(/\n\n+/).map((b) => b.trim()).filter(Boolean);
      for (const block of blocks) {
        let wtPath = "";
        let headBranch = "";
        for (const line of block.split("\n")) {
          if (line.startsWith("worktree ")) {
            wtPath = line.slice("worktree ".length).trim();
          }
          if (line.startsWith("branch ")) {
            const ref = line.slice("branch ".length).trim();
            headBranch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
          }
        }
        if (!wtPath) continue;
        const samePath = resolve(wtPath) === target;
        // Never remove the primary repo worktree: only match branch under `.worktrees/`.
        const sameBranchHere = headBranch === branch && this.isUnderProjectWorktrees(wtPath);
        if (samePath || sameBranchHere) {
          try {
            this.git(`worktree remove "${wtPath}" --force`);
            removed = true;
            log.debug(`Removed registered worktree at ${wtPath}`);
          } catch {
            try {
              execSync(`rm -rf "${wtPath}"`, { encoding: "utf-8" });
            } catch {
              /* ignore */
            }
          }
        }
      }
    } catch {
      // porcelain/list failed — fall through to path-based remove
    }

    if (existsSync(wPath)) {
      log.warn("Worktree path still on disk after git cleanup, forcing remove");
      try {
        this.git(`worktree remove "${wPath}" --force`);
        removed = true;
      } catch {
        try {
          execSync(`rm -rf "${wPath}"`, { encoding: "utf-8" });
        } catch {
          /* ignore */
        }
      }
    }

    try {
      this.git("worktree prune");
    } catch {
      /* ignore */
    }

    try {
      this.git(`branch -D ${branch}`);
    } catch {
      // branch absent or still in use until prune propagates
    }

    if (removed) {
      log.info("Released stale worktree / branch lock for this ticket");
    }
  }

  createWorktree(key: string): string {
    const log = createLogger(key);
    const branch = this.branchName(key);
    const wPath = this.worktreePath(key);

    this.git(`fetch ${this.config.remote} ${this.config.baseBranch} --prune`);

    this.releaseTicketGitSlot(wPath, branch, log);

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

  deleteBranch(key: string): void {
    const log = createLogger(key);
    const branch = this.branchName(key);
    try {
      this.git(`branch -D ${branch}`);
      log.debug(`Deleted local branch ${branch}`);
    } catch { /* branch doesn't exist locally */ }
    try {
      execSync(`git push ${this.config.remote} --delete ${branch}`, {
        cwd: this.config.path, encoding: "utf-8", stdio: "pipe", timeout: GIT_TIMEOUT_MS,
      });
      log.debug(`Deleted remote branch ${branch}`);
    } catch { /* remote branch doesn't exist */ }
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
        timeout: GIT_TIMEOUT_MS,
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
        timeout: INSTALL_TIMEOUT_MS,
      });
      log.info("Dependencies installed");
    } catch (err) {
      log.warn(`Dependency install failed: ${toErrorMessage(err).slice(0, 200)}`);
    }
  }
}
