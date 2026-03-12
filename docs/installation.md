# Installation

## Prerequisites

- **Claude Code CLI** -- installed and on your PATH. [Get Claude Code](https://docs.anthropic.com/en/docs/claude-code).
- **Git 2.25+** -- required for worktree support. Run `git --version` to check.

## Quick Install (Recommended)

```bash
npx kangentic
```

This downloads the pre-built binary for your platform, installs it, and launches the app. After the first run, auto-updates handle everything (Windows and macOS). Linux users re-run `npx kangentic` to update.

To open a specific project:

```bash
npx kangentic /path/to/your/project
```

To install a specific version:

```bash
npx kangentic@0.2.0
```

## Manual Download

Download the latest release for your platform from [GitHub Releases](https://github.com/Kangentic/kangentic/releases/latest).

| Platform | File | Notes |
|----------|------|-------|
| Windows | `Kangentic Setup X.Y.Z.exe` | NSIS installer. Auto-updates. |
| macOS | `Kangentic-X.Y.Z.dmg` | Drag to Applications. See [Gatekeeper note](#macos-gatekeeper). |
| Linux (Debian/Ubuntu) | `kangentic_X.Y.Z_amd64.deb` | `sudo dpkg -i kangentic_*.deb` |
| Linux (Fedora/RHEL) | `kangentic-X.Y.Z-1.x86_64.rpm` | `sudo rpm -i kangentic-*.rpm` |

### Windows

1. Download the `.exe` installer.
2. Run it -- the NSIS installer handles installation and creates a Start Menu shortcut.
3. If Windows SmartScreen warns about an unrecognized app, click **More info** then **Run anyway**. This happens because the app is not yet code-signed.
4. Auto-updates are built in. New versions install silently on restart.

### macOS

1. Download the `.dmg` file.
2. Open it and drag Kangentic to your Applications folder.
3. On first launch, macOS Gatekeeper may block the app. See [Gatekeeper bypass](#macos-gatekeeper) below.

#### macOS Gatekeeper

Since the app is not yet notarized, macOS will block it on first launch:

1. Open **System Settings > Privacy & Security**.
2. Scroll to the bottom -- you'll see a message about Kangentic being blocked.
3. Click **Open Anyway**.
4. Alternatively, right-click the app in Finder, select **Open**, then click **Open** in the dialog.

### Linux

Install with your package manager:

```bash
# Debian/Ubuntu
sudo dpkg -i kangentic_X.Y.Z_amd64.deb

# Fedora/RHEL
sudo rpm -i kangentic-X.Y.Z-1.x86_64.rpm
```

Linux does not have built-in auto-updates. Download new releases manually from GitHub.

### WSL Note

Kangentic is a GUI desktop application. If you use WSL, install the **Windows** version -- it runs as a native Windows app and can use WSL shells for agent sessions. Do not attempt to install the Linux version inside WSL.

## From Source

For contributors or users who want to run from source:

```bash
git clone https://github.com/Kangentic/kangentic.git
cd kangentic
npm install
npm run dev
```

Requires:
- Node.js 22+
- C++ build tools for native modules (better-sqlite3, node-pty)
  - **Windows:** `npm install -g windows-build-tools` or install Visual Studio Build Tools
  - **macOS:** Xcode Command Line Tools (`xcode-select --install`)
  - **Linux:** `build-essential` package (`sudo apt install build-essential`)

## Troubleshooting

### Claude Code CLI not found

Kangentic requires the Claude Code CLI (`claude`) on your PATH. Verify it's installed:

```bash
claude --version
```

If not installed, follow the [Claude Code setup guide](https://docs.anthropic.com/en/docs/claude-code).

### Linux arm64

Pre-built arm64 Linux binaries are not available in v1. arm64 Linux users should [build from source](#from-source).

### Windows SmartScreen warning

The app is not yet code-signed. Click **More info** then **Run anyway** to proceed. Once code signing certificates are configured, this warning will no longer appear.

### macOS "app is damaged" error

If you see "app is damaged and can't be opened", the quarantine attribute needs to be removed:

```bash
xattr -cr /Applications/Kangentic.app
```

### Native module build failures

If `npm install` fails on native modules:

- Ensure you have C++ build tools installed (see [From Source](#from-source) above).
- On Windows, ensure Python 3.x is available (required by node-gyp).
- Try clearing the npm cache: `npm cache clean --force` then `npm install` again.

## Uninstall

### Windows

1. Open **Settings > Apps > Installed apps**.
2. Find "Kangentic" and click **Uninstall**.
3. Or run from command line: `%LOCALAPPDATA%\Kangentic\Update.exe --uninstall`
4. To remove all data: delete `%APPDATA%\kangentic\`

### macOS

1. Drag Kangentic from Applications to the Trash.
2. To remove all data: delete `~/Library/Application Support/kangentic/`

### Linux

```bash
# Debian/Ubuntu
sudo dpkg -r kangentic

# Fedora/RHEL
sudo rpm -e kangentic
```

To remove all data: delete `~/.config/kangentic/`

## Custom Data Directory

By default, Kangentic stores its global database and project data in:

| Platform | Default path |
|----------|-------------|
| Windows | `%APPDATA%\kangentic\` |
| macOS | `~/Library/Application Support/kangentic/` |
| Linux | `~/.config/kangentic/` |

To use a custom location, pass `--data-dir` or set the `KANGENTIC_DATA_DIR` environment variable:

```bash
# Using the flag
npx kangentic --data-dir=/path/to/data

# Using the environment variable
KANGENTIC_DATA_DIR=/path/to/data npx kangentic
```

If both are set, the environment variable takes priority. This is useful for running separate dev and production instances side by side.
