export { getProjectRepos } from './project-repos';
export { ensureGitignore } from './project-setup';
export { ensureTaskWorktree, ensureTaskBranchCheckout } from './task-git';
export { buildAutoCommandVars, createTransitionEngine, spawnAgent, autoSpawnForTask } from './agent-spawn';
export type { AgentSpawnOptions } from './agent-spawn';
export { cleanupTaskSession, cleanupTaskResources } from './task-cleanup';
