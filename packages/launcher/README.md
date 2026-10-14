# Kangentic

**Drag a card. An agent starts.**

An agentic development environment for AI coding agents. This package installs the desktop app and opens it.

![The Kangentic board with tasks in To Do, Planning, Executing, and Code Review, and the selected agent's terminal open below.](https://raw.githubusercontent.com/Kangentic/kangentic/main/docs/images/readme-board-dark.png)

## Install and run

```bash
npx kangentic
```

The launcher downloads the release that matches its own version from [GitHub Releases](https://github.com/Kangentic/kangentic/releases), installs it, and opens it:

- **Windows.** A per-user install to `%LOCALAPPDATA%\Programs\Kangentic`.
- **macOS.** `Kangentic.app` in `~/Applications`.
- **Linux.** The `.rpm` package (dnf, zypper, or rpm) or the `.deb` package (apt or dpkg). This asks for your password.

To open a project directly:

```bash
npx kangentic /path/to/your/project
```

To install a specific release, run `npx kangentic@<version>`. The launcher version matches the app version.

## Updates

The app updates itself. On Windows and macOS a downloaded update installs when you quit. On Linux, click **Restart to update** and enter your password. If that fails, run `npx kangentic@latest`, then quit and reopen the app.

## Requirements

- Windows x64, macOS 13 or later on Apple Silicon, or Linux x64.
- Node.js 20 or later, and Git 2.26 or later.
- At least one supported agent CLI, such as Claude Code, Codex CLI, or Gemini CLI, installed and signed in.

## Privacy

Release builds send anonymous usage events and error reports by default. Set `KANGENTIC_TELEMETRY=0` to turn them off. See the [privacy page](https://www.kangentic.com/privacy/).

## Links

- [Source code and full README](https://github.com/Kangentic/kangentic)
- [Live demo](https://kangentic.github.io/kangentic/)
- [Quickstart](https://www.kangentic.com/getting-started/)
- [Installation guide](https://www.kangentic.com/guide/installation/)

## License

[AGPL-3.0-only](https://github.com/Kangentic/kangentic/blob/main/LICENSE)
