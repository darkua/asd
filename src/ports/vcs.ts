export interface VCS {
  ensureReady(): void;
  branchName(key: string): string;
  branchExists(key: string): boolean;
  worktreePath(key: string): string;
  createWorktree(key: string): string;
  removeWorktree(key: string): void;
  closePR(key: string): void;
}
