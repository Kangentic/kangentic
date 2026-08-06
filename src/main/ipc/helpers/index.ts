export { getProjectRepos } from './project-repos';
// resolveProjectContext is intentionally NOT re-exported through this barrel:
// handlers import it directly from './project-repos'. It is a pure context
// reader, and many handler unit tests vi.mock this barrel to stub the
// side-effectful helpers (getProjectRepos, ensureTaskWorktree, ...). Importing
// the pure resolver from the submodule keeps those tests exercising the real
// implementation instead of forcing every mock to re-declare it.
export { ensureGitignore } from './project-setup';
export {
  ensureTaskWorktree,
  ensureTaskBranchCheckout,
  notifyBranchCheckoutBlocked,
  BranchCheckoutBlockedError,
} from './task-git';
export { createTransitionEngine, spawnAgent, autoSpawnForTask, resolveSpawnOverrides } from './agent-spawn';
export type { AgentSpawnOptions } from './agent-spawn';
export { cleanupTaskSession, cleanupTaskResources, deleteTaskWorktree } from './task-cleanup';
export { openAttachmentFile, OPEN_PATH_TIMEOUT_MS } from './attachment-open';
export type { OpenableAttachment, OpenAttachmentOptions } from './attachment-open';
