import type { IpcContext } from '../ipc-context';

/**
 * The project's default base branch: the team-shared board default for THIS
 * project's path, else the effective config default, else 'main'.
 *
 * Board-before-config matches how CONFIG_GET and the transition-engine factory
 * overlay the board default onto `git.defaultBaseBranch`, so every consumer of
 * this chain (a task's effective base in `resolveEffectiveBaseBranch`, the
 * Command Terminal's cold-spawn checkout target, the worktree list's `baseRef`)
 * names the same branch the renderer's pickers show as the default. The ForPath
 * variant matters because MCP calls can target a background project, where the
 * ACTIVE board's default belongs to the wrong board.
 *
 * Deliberately imports nothing from `src/main/git`, so the transient-session
 * handler can use it without dragging the worktree manager into its graph.
 */
export function resolveProjectDefaultBaseBranch(context: IpcContext, projectPath: string): string {
  return context.boardConfigManager.getDefaultBaseBranchForPath(projectPath)
    || context.configManager.getEffectiveConfig(projectPath).git.defaultBaseBranch
    || 'main';
}
