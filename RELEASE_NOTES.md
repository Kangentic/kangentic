## What's New

- The Changes button shows the task's git state, and commits, pushes and creates a pull request from there. ([#933](https://github.com/Kangentic/kangentic/pull/933))
- Under Automatic account order, running sessions, Command Terminals and workflow agents move to the agent's top account with room at their next safe pause. The Accounts tab no longer shows a 5h line for a plan with no 5h limit. ([#940](https://github.com/Kangentic/kangentic/pull/940))
- Settings > Accounts shows at once after a restart instead of waiting on agent detection. ([#941](https://github.com/Kangentic/kangentic/pull/941))
- A failure toast now says when the failure was automatically reported to Kangentic, and Kangentic tells you after a crash it reported. ([#927](https://github.com/Kangentic/kangentic/pull/927))
- Codex: pasted images attach, subagents are tracked, a Command Terminal ends as soon as Codex exits, and closing a session exits Codex cleanly instead of killing it. ([#926](https://github.com/Kangentic/kangentic/pull/926))
- Fewer stalls: git reads, ssh, scripts, automations and process scans no longer start from Kangentic's main process, and startup starts an agent's CLI only for an agent you use. ([#937](https://github.com/Kangentic/kangentic/pull/937), [#935](https://github.com/Kangentic/kangentic/pull/935))

## Bug Fixes

- OpenCode 1 tasks in a worktree showed no tool activity, questions or context usage. ([#929](https://github.com/Kangentic/kangentic/issues/929))
- When idle no longer pauses an agent while its task window is open. ([#930](https://github.com/Kangentic/kangentic/pull/930))
- Kangentic removes the `~/.claude.json` trust entries it left for task worktrees that no longer exist, and an account's copy no longer puts them back. ([#928](https://github.com/Kangentic/kangentic/pull/928))
- Codex says when it refuses a project config or a launch, and a folder on an unplugged drive keeps its trust. ([#926](https://github.com/Kangentic/kangentic/pull/926))
- An OS passkey dialog no longer opens over a Browser pane an agent controls. ([#921](https://github.com/Kangentic/kangentic/pull/921))
- The Stop script's held-message note says the agent was paused for being idle, not that its automations were paused. ([#920](https://github.com/Kangentic/kangentic/pull/920))
- Automatic order no longer puts an account whose week just reset ahead of the others before its next usage read. ([#914](https://github.com/Kangentic/kangentic/pull/914))
- Missing Simplified and Traditional Chinese strings are filled in. ([#912](https://github.com/Kangentic/kangentic/pull/912))
