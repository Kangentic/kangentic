# Installation

## Prerequisites

- **Claude Code CLI** -- installed and on your PATH. [Get Claude Code](https://docs.anthropic.com/en/docs/claude-code).
- **Git 2.26+** -- required for worktree support. Run `git --version` to check.
- **macOS 13 (Ventura) or later** on a Mac. Electron 44 does not start on macOS 12.

## Quick Install (Recommended)

```bash
npx kangentic
```

This downloads the pre-built binary for your platform, installs it, and launches the app. After the first run, auto-updates handle everything on Windows, macOS, and Linux.

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
| Windows | `Kangentic-Setup-X.Y.Z.exe` | NSIS installer. Auto-updates. |
| macOS (Apple Silicon) | `Kangentic-X.Y.Z-arm64.dmg` | Drag to Applications. See [Gatekeeper note](#macos-gatekeeper). |
| Linux (Debian/Ubuntu) | `kangentic_X.Y.Z_amd64.deb` | `sudo apt install ./kangentic_*.deb` |
| Linux (Fedora/RHEL/openSUSE) | `kangentic-X.Y.Z-1.x86_64.rpm` | `sudo dnf install kangentic-*.rpm` |

### Windows

1. Download the `.exe` installer.
2. Run it -- the NSIS installer handles installation and creates a Start Menu shortcut.
3. If Windows SmartScreen warns about an unrecognized app, click **More info** then **Run anyway**. Releases are code-signed, but SmartScreen can still warn about a new release until enough people have downloaded it.
4. Auto-updates are built in. New versions install silently on restart.

### macOS

1. Download the `.dmg` file.
2. Open it and drag Kangentic to your Applications folder.
3. Releases are signed and notarized, so macOS opens them normally. If Gatekeeper blocks the app anyway, see [Gatekeeper bypass](#macos-gatekeeper) below.

#### macOS Gatekeeper

A build you made yourself is not notarized, and macOS blocks it on first launch:

1. Open **System Settings > Privacy & Security**.
2. Scroll to the bottom -- you'll see a message about Kangentic being blocked.
3. Click **Open Anyway**.
4. Alternatively, right-click the app in Finder, select **Open**, then click **Open** in the dialog.

### Linux

Install with your package manager:

```bash
# Debian/Ubuntu
sudo apt install ./kangentic_X.Y.Z_amd64.deb

# Fedora/RHEL
sudo dnf install kangentic-X.Y.Z-1.x86_64.rpm

# openSUSE
sudo zypper install kangentic-X.Y.Z-1.x86_64.rpm
```

`apt install` and `dnf install` resolve and fetch missing dependencies automatically. `dpkg -i`
and `rpm -i` (still supported) do not - a missing library fails with a raw dependency error
instead of being installed.

Linux has built-in auto-updates: the app downloads the new deb/rpm and installs it when you click
"Restart to update", asking for your password once. Unlike Windows and macOS there is no
install-on-quit. See [Linux auto-update](deployment.md#linux-auto-update).

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
- Node.js 22.14+ or 24+ (better-sqlite3 13 needs Node-API 10, and older Node 22 releases crash on the first database open instead of reporting it)
- C++ build tools, on Linux and macOS only
  - **Windows:** none. Every native module ships a prebuilt Windows binary
  - **macOS:** Xcode Command Line Tools (`xcode-select --install`), which a macOS package build needs for node-pty's `spawn-helper`
  - **Linux:** `build-essential` and `python3` (`sudo apt install build-essential python3`), because node-pty ships no Linux binary and compiles on install

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

Releases are code-signed, but SmartScreen can still warn about a new release until enough people
have downloaded it. Click **More info** then **Run anyway** to proceed.

### Windows: Kangentic closes right after it starts

Since 0.44, Kangentic checks at startup that its sandboxed processes can read the install folder.
On a few machines the per-user install folder carries an access entry left by a packaged app but no
read grant for packaged apps, and Kangentic exits before its window opens. The installer adds that
grant on every install and update. If an install still closes at once, run this in PowerShell and
start Kangentic again:

```powershell
icacls "$env:LOCALAPPDATA\Programs\Kangentic" /grant "*S-1-15-2-1:(OI)(CI)(RX)"
```

### macOS "app is damaged" error

If you see "app is damaged and can't be opened", the quarantine attribute needs to be removed:

```bash
xattr -cr /Applications/Kangentic.app
```

### Native module build failures

If `npm install` fails on native modules:

- On Linux, ensure `build-essential` and `python3` are installed (see [From Source](#from-source) above). node-pty is the one module that compiles there.
- Try clearing the npm cache: `npm cache clean --force` then `npm install` again.

## Uninstall

### Windows

1. Open **Settings > Apps > Installed apps**.
2. Find "Kangentic" and click **Uninstall**.
3. Or run the uninstaller directly: `"%LOCALAPPDATA%\Programs\Kangentic\Uninstall Kangentic.exe"`
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
