---
paths:
  - "src/main/agent/mcp-http/**"
  - "src/main/agent/commands/**"
  - "src/main/agent/mcp-http-server.ts"
  - "src/main/remote/host-paths.ts"
  - "docs/integrations/mcp-server/**"
  - "tests/unit/mcp-*.test.ts"
---
# Rule: an MCP tool answers from the layer its fact belongs to

A remote project (#913) splits one task across two machines. The board, the UI, the Browser pane and
the app's logs live on this computer (the presentation layer). The agent, its worktree, its git, its
processes and its dev servers live on a Linux host (the execution layer). For each remote task this
computer holds an empty stand-in folder at `<shell folder>/.kangentic/worktrees/<n>`, and the same
folder on the host is `<remote.path>/.kangentic/worktrees/<n>`.

The MCP server answers an agent that runs on the host, but it runs in main on this computer. Every
tool that reads `task.worktree_path`, `sessions.cwd` or `project.path` therefore hands the agent the
stand-in, a Windows path that does not exist where the agent works. Nothing fails loudly. The agent
takes the path at its word. The audit that found this (the SSH task's MCP review) listed paths,
`isMainCheckout` and `dirty` on `list_worktrees` that read false or empty, a branch-conflict guard
that skipped itself, a screenshot written to a Windows path the agent was told to read back, and a
port reported "genuinely free" that was only free on this computer.

## The rule

- **A fact about where the agent works is the host's value.** A worktree or project path, a session
  `cwd`, a git or process fact, and a port the agent's server listens on come back as the host
  sees them, never as the stand-in or this computer's value. One shared helper
  (`agentPathsForProject`, `src/main/remote/host-paths.ts`) maps a stand-in to the host path
  (`toAgent`) and an agent-typed host path back (`fromAgent`). A tool does not call
  `localPathToHost` or compare paths itself.
- **A fact about this computer stays local and is labeled.** The Browser pane, a forwarded local port,
  the app's own logs and Kangentic's process metrics are the user's computer. They are returned as
  they are, with `location: 'local'` in `data` and a short note in the message, so an agent on a host
  does not read them as its own.
- **Every path, URL, pid or port in `data` carries a `location` of `'host'` or `'local'`.** Never put a
  host value and a local value in one unlabeled field. For a remote project the main field holds the
  host's value and the stand-in sits under a `local*` or `shellFolder` field. For a local project
  `location` is `'local'` and every value is unchanged.
- **An input path is a host path by default for a remote project.** A path the agent passes (an
  attachment, a `cwd`, a file to drop) names a file on the host. Reading it from this disk finds
  nothing, or a different file of the same path on macOS and Linux. Fetch it through the helper, or
  refuse it with a sentence. A failure is reported to the agent, never swallowed.
- **A copy is labeled as a copy.** A transcript, an events file or a session file that reaches this
  computer through the relay is a copy of the host's. Its content is the host's and may be stale. Its
  local path is not openable by the agent, so a tool returns the host path of the original beside it.
- **A check that tests a path on this disk is wrong for a remote project.** `isGitRepo(projectPath)`,
  `fs.existsSync(worktree_path)` and a local bind probe each answer about the stand-in. A remote
  project asks the host through its resolver (`remoteGitRunnerFor`, the helper's `pathPresence`,
  its listening-ports read). A failed ask is an error, never "free" or "absent"
  ([[ssh-remote]]).

## Enforcement (self-maintaining)

- **Test (mechanical, CI):** `tests/unit/mcp-tool-host-values.test.ts` scans every handler under
  `src/main/agent/commands/` and `src/main/agent/mcp-http/` that reads `worktree_path`,
  `sessions.cwd` or `getProjectPath()` into a response, and fails unless it goes through
  `agentPaths`. A tool whose output is correctly local or has no path is listed in the test's
  allowlist with a reason, so a new tool that prints a path fails CI instead of passing silently.
  The per-tool remote fixtures (`tests/unit/mcp-remote-*.test.ts`) pin the host values. These land
  with the follow-up task that implements the helper; until then this rule is review-only.
- **Review:** `/code-review` flags a new or changed tool that returns a path, pid, port or URL
  without `location`, reads `worktree_path`, `sessions.cwd` or `project.path` straight into a
  response, or tests a path on this disk for a project that may be remote.

## Scope

Every tool registered under `src/main/agent/mcp-http/*-tools.ts` and the command handlers behind them
in `src/main/agent/commands/`, for both their responses and the inputs they accept. Tools that read
only the database and return counts and ids are out of scope. The dev-only `kangentic_devtools_*`
tools are out of scope. The tool list itself is governed by [[mcp-tool-list-parity]], and how a
remote project's paths map is in [[ssh-remote]] and `docs/platforms/ssh-remote.md`.
