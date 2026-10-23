# Integrations

## Outside tools Kangentic drives or connects to

* [Agents](agents/index.md) - The AgentAdapter contract, one concept per supported agent CLI (detection, command, hooks, MCP, trust, permission modes), and the shared bridge scripts, session history readers, handoff and relocation.
* [MCP server](mcp-server/index.md) - The in-process MCP server agents call back into: its security model and discovery, then every kangentic_* tool grouped by what it acts on (tasks, columns, backlog, workflows, sessions, search, browser, diagnostics).
* [Pull requests](pull-requests/index.md) - How a task finds and tracks its PR: the connector contract, the GitHub and Azure DevOps connectors, the confidence ladder that links a PR, and the refresh scheduler.
* [Mobile bridge](mobile-bridge/index.md) - The desktop half of the phone companion: pairing and the signed roster, the Noise session, the capability verbs and data feeds a phone uses, encrypted push, and the relay transport.
* [Board integration](boards.md) - The BoardAdapter contract for importing issues from GitHub, Azure DevOps and Asana, the Jira, Linear and Trello stubs, safeStorage async-API behavior for stored credentials, the registry and URL parsers, and the steps to add a provider.
