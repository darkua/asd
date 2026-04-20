import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { GIT_TIMEOUT_MS } from "../constants.js";
import { createLogger } from "../logger.js";
import { toErrorMessage } from "./errors.js";

const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
const CLONE_TIMEOUT_MS = Math.min(GIT_TIMEOUT_MS * 6, 600_000);

function parseHttpsCloneUrl(raw: string): URL {
  const trimmed = raw.trim();
  try {
    const u = new URL(trimmed);
    if (u.protocol !== "https:") {
      throw new Error("not https");
    }
    if (!u.hostname) {
      throw new Error("missing host");
    }
    return u;
  } catch {
    throw new Error(
      `REPO_GIT_URL must be an https:// clone URL (example: https://github.com/org/repo.git). Got: ${raw.slice(0, 80)}`,
    );
  }
}

/** Map clean https://host/... fetches to token-authenticated HTTPS (no SSH host keys). */
function configureGitInsteadOf(host: string, token: string): void {
  const cleanPrefix = `https://${host}/`;
  const authKey = `url.https://x-access-token:${token}@${host}/.insteadOf`;
  execFileSync("git", ["config", "--global", authKey, cleanPrefix], {
    encoding: "utf-8",
    stdio: "pipe",
    env: GIT_ENV,
  });
}

function assertDirEmptyForInit(repoPath: string): void {
  if (!existsSync(repoPath)) {
    return;
  }
  const skip = new Set([".DS_Store"]);
  const entries = readdirSync(repoPath).filter((e) => !skip.has(e));
  if (entries.length > 0) {
    throw new Error(
      `REPO_PATH "${repoPath}" is not a git clone but is not empty. Use an empty directory or omit it when using REPO_GIT_URL.`,
    );
  }
}

/**
 * Ensures {@link repoPath} is a clone of {@link cleanCloneUrl} using {@link token} for HTTPS.
 * Call before `GitVCS` in container/CI where `origin` would otherwise be ssh:// and fail host-key checks.
 */
export function ensureRepoFromRemote(opts: {
  repoPath: string;
  cleanCloneUrl: string;
  token: string;
  remote: string;
  baseBranch: string;
}): void {
  const log = createLogger();
  const clean = opts.cleanCloneUrl.trim().replace(/\/$/, "");
  const u = parseHttpsCloneUrl(clean);
  const host = u.host;

  configureGitInsteadOf(host, opts.token);

  const gitDir = join(opts.repoPath, ".git");

  try {
    if (existsSync(gitDir)) {
      execFileSync("git", ["remote", "get-url", opts.remote], {
        cwd: opts.repoPath,
        encoding: "utf-8",
        stdio: "pipe",
        env: GIT_ENV,
        timeout: GIT_TIMEOUT_MS,
      });
      execFileSync("git", ["remote", "set-url", opts.remote, clean], {
        cwd: opts.repoPath,
        encoding: "utf-8",
        stdio: "pipe",
        env: GIT_ENV,
        timeout: GIT_TIMEOUT_MS,
      });
      execFileSync("git", ["fetch", opts.remote], {
        cwd: opts.repoPath,
        encoding: "utf-8",
        stdio: "pipe",
        env: GIT_ENV,
        timeout: CLONE_TIMEOUT_MS,
      });
      log.info(`Repo ready at ${opts.repoPath} (HTTPS origin + fetch)`);
      return;
    }

    if (!existsSync(opts.repoPath)) {
      mkdirSync(dirname(opts.repoPath), { recursive: true });
      execFileSync(
        "git",
        ["clone", "-b", opts.baseBranch, "--single-branch", "-o", opts.remote, clean, opts.repoPath],
        {
          encoding: "utf-8",
          stdio: "pipe",
          env: GIT_ENV,
          timeout: CLONE_TIMEOUT_MS,
        },
      );
      log.info(`Cloned repository to ${opts.repoPath}`, { branch: opts.baseBranch, remote: opts.remote });
      return;
    }

    assertDirEmptyForInit(opts.repoPath);
    execFileSync(
      "git",
      ["clone", "-b", opts.baseBranch, "--single-branch", "-o", opts.remote, clean, "."],
      {
        cwd: opts.repoPath,
        encoding: "utf-8",
        stdio: "pipe",
        env: GIT_ENV,
        timeout: CLONE_TIMEOUT_MS,
      },
    );
    log.info(`Cloned repository into ${opts.repoPath}`, { branch: opts.baseBranch, remote: opts.remote });
  } catch (err) {
    throw new Error(`REPO_GIT_URL bootstrap failed: ${toErrorMessage(err)}`);
  }
}
