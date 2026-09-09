# Security Policy

## Reporting a vulnerability

Use GitHub's [private vulnerability reporting](https://github.com/Kangentic/kangentic/security/advisories/new),
or email **support@kangentic.com** if you would rather not go through GitHub. Please do not open a
public GitHub issue for a security problem, so we can ship a fix before the details are public.

Include whatever you have:

- What the issue is, and how bad you think it is
- Steps to reproduce, or a proof of concept
- The Kangentic version you are running and your OS
- Relevant logs, with file paths and project names stripped out

We aim to acknowledge reports within a few business days and will keep you posted as we work on a
fix. If you do not hear back within a week, send a follow-up: the message may have gone astray.

## Supported versions

Only the latest release. Kangentic auto-updates, so fixes ship in the next release and there are no
backported patches for older versions.

## Scope

**In scope:**

- The desktop app (Electron main, preload, and renderer processes)
- The local MCP server Kangentic exposes to agent sessions
- The mobile bridge, its pairing flow, and the hosted relay
- The published npm packages, `kangentic` and `@kangentic/protocol`

**Out of scope:**

- **Code execution through the product's own purpose.** Kangentic runs agent CLIs, shell commands,
  and column auto-commands on your machine by design. A configured command running is the product
  working, not a vulnerability.
- **Findings in third-party agent CLIs** such as Claude Code, Codex, Gemini, or OpenCode. Report
  those to their maintainers.
- **Dependency advisories with no reachable path** in Kangentic, and hardening suggestions with no
  demonstrated impact.

## Disclosure

We are happy to credit you for the report unless you would rather stay anonymous. Please give us a
reasonable window to ship a fix before publishing your findings.
