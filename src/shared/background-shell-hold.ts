/**
 * Opt-out marker letting a background shell declare itself NON-HOLDING for
 * activity purposes.
 *
 * A `Bash(run_in_background: true)` shell normally pins its session `thinking`
 * for as long as it runs, which is correct for real agent work (an `npm
 * install`, a long build). It is wrong for a shell that merely OBSERVES a
 * user-facing service: `/preview`'s watcher blocks for the preview's entire
 * lifetime (hours), so the board read the task ACTIVE the whole time and the
 * user lost the only signal that says which agent needs them.
 *
 * The engine cannot tell the two apart - the shell is genuinely alive and
 * correctly detected in both cases. Only the caller knows. So the caller says
 * so, by putting this flag in the command it launches:
 *
 *   node scripts/worktree-preview.js --wait --port=5174 --kangentic-no-activity-hold
 *
 * The flag rides in `tool_input.command`, which the PreToolUse hook surfaces as
 * the event `detail` (see `hook-manager.ts`). `updateCounters` matches it there
 * and tracks the shell in `exemptBackgroundShellIds` instead of
 * `activeBackgroundShellIds`, which is the set the predicate sums. Exempt
 * shells stay fully tracked everywhere else - the process-tree watcher still
 * captures their PID, confirms their liveness, and drains them on exit.
 *
 * Being agent-typed (it rides in a command string an agent wrote) puts it on
 * the same trust boundary as every other hook-sourced field in this pipeline.
 *
 * DUPLICATED BY HAND in two places that cannot import this module:
 *   - `scripts/worktree-preview.js` (CommonJS, cannot import a `.ts` module),
 *     which prints the `Watch:` command the agent runs.
 *   - `.claude/skills/preview/SKILL.md`, which is markdown.
 * `tests/unit/no-activity-hold-sentinel-parity.test.ts` pins all three copies
 * together.
 */
export const NO_ACTIVITY_HOLD_FLAG = '--kangentic-no-activity-hold';
