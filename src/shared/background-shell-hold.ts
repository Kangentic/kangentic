/**
 * How a background shell declares itself NON-HOLDING for activity purposes.
 *
 * A `Bash(run_in_background: true)` shell normally pins its session `thinking`
 * for as long as it runs, which is correct for real agent work (an `npm
 * install`, a long build the agent is waiting on). It is wrong for a shell that
 * is a service left running after the turn: a dev server, a watcher, or
 * `/preview`'s watcher, which blocks for the preview's entire lifetime (hours).
 * The board read the task ACTIVE the whole time, the user lost the only signal
 * that says which agent needs them, and the column's On agent turn end
 * automations never ran.
 *
 * The engine cannot tell the two apart - the shell is genuinely alive and
 * correctly detected in both cases. Only the agent knows, so the agent says so,
 * in one of two ways. Both land the shell in `exemptBackgroundShellIds`, which
 * no activity site sums; exempt shells stay fully tracked everywhere else (the
 * process-tree watcher still captures their PID, confirms their liveness, and
 * drains them on exit).
 *
 * 1. At launch, with `NO_ACTIVITY_HOLD_FLAG` in the command it runs:
 *
 *      node scripts/worktree-preview.js --wait --port=5174 --kangentic-no-activity-hold
 *
 *    For Claude the flag rides in `tool_input.command`, which the PreToolUse
 *    hook surfaces as the event `detail` (see `hook-manager.ts`), on a
 *    `background_shell_start` for a Bash `run_in_background` launch and on a
 *    plain `tool_start` for any other tool. `updateCounters` matches it there.
 *    For the agents whose post-tool hook reports the launch with no tool id
 *    (Gemini, Copilot), the event bridge reads it from the command and sets
 *    `noActivityHold` on the start itself; Kimi's and Codex's history parsers
 *    carry it the same ways (task #859). Commands Kangentic writes for the
 *    agent (`/preview`'s watcher) carry it.
 *
 * 2. After launch, with the `MARK_BACKGROUND_SERVICE_TOOL` MCP tool, naming the
 *    shell id. A post-tool hook tells the agent about it whenever a background
 *    launch carries no flag (`background-shell-hint-bridge.js`; Claude, Qwen,
 *    Gemini and Copilot), so the agent decides at the moment it knows the
 *    answer (task #857). The server offers the tool only to an agent that
 *    reports its background commands (`AgentAdapter.backgroundCommands`).
 *
 * Being agent-typed (it rides in a command string, or a tool call, an agent
 * wrote) puts both on the same trust boundary as every other hook-sourced
 * field in this pipeline.
 *
 * The flag is DUPLICATED BY HAND in three places that cannot import this module:
 *   - `scripts/worktree-preview.js` (CommonJS, cannot import a `.ts` module),
 *     which prints the `Watch:` command the agent runs.
 *   - `.claude/skills/preview/SKILL.md`, which is markdown.
 *   - `CLAUDE.md`, whose example puts it on a background dev server.
 * `tests/unit/no-activity-hold-sentinel-parity.test.ts` pins all four copies
 * together.
 */
export const NO_ACTIVITY_HOLD_FLAG = '--kangentic-no-activity-hold';

/**
 * The MCP tool an agent calls to mark background shells it started as services
 * (`src/main/agent/mcp-http/background-shell-tools.ts`). The registration keeps
 * its own string literal, because `mcp-tool-list-parity` reads registrations
 * as literals; `background-shell-tools.test.ts` pins the two together.
 */
export const MARK_BACKGROUND_SERVICE_TOOL = 'kangentic_mark_background_service';
