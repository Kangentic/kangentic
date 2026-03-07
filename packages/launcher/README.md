# Kangentic

**Visual Agent Orchestration for Claude Code**

One command to install and launch [Kangentic](https://github.com/Kangentic/kangentic) -- a cross-platform desktop Kanban for Claude Code agents.

## Install

```bash
npx kangentic
```

This downloads the pre-built binary for your platform from GitHub Releases, installs it, and launches the app. After the first run, the app manages its own updates automatically (Windows and macOS).

### Open a specific project

```bash
npx kangentic /path/to/your/project
```

## How it works

1. Detects your platform (Windows, macOS, Linux) and architecture (x64, arm64)
2. Downloads the matching installer from [GitHub Releases](https://github.com/Kangentic/kangentic/releases)
3. Installs per platform:
   - **Windows:** Runs Squirrel Setup.exe silently to `%LOCALAPPDATA%\Kangentic\`
   - **macOS:** Extracts .zip to `~/Applications/Kangentic.app`
   - **Linux:** Installs .deb via `sudo dpkg -i` (prompts for password)
4. Launches the app

## Updates

After the initial install, you generally don't need to run `npx kangentic` again:

- **Windows:** Squirrel auto-updater installs new versions silently on restart.
- **macOS:** Built-in auto-updater downloads in the background and prompts to restart. (Requires code signing.)
- **Linux:** No auto-update. Re-run `npx kangentic` or download from [GitHub Releases](https://github.com/Kangentic/kangentic/releases).

### Install a specific version

```bash
npx kangentic@0.2.0
```

The launcher version matches the app version. Specifying a version downloads that exact release.

## Prerequisites

- **[Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code)** installed and on your PATH
- **[Git 2.25+](https://git-scm.com/)** for worktree support

## Links

- [GitHub](https://github.com/Kangentic/kangentic)
- [Documentation](https://github.com/Kangentic/kangentic/tree/main/docs)
- [Installation Guide](https://github.com/Kangentic/kangentic/blob/main/docs/installation.md)

## License

[AGPL-3.0-only](https://github.com/Kangentic/kangentic/blob/main/LICENSE)
