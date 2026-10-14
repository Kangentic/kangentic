# Installation

## Prerequisites

- **At least one agent CLI**, such as Claude Code, Codex CLI, or Gemini CLI, installed, signed in, and on your PATH. The app opens without one but needs one to run tasks. See [supported agents](../README.md#supported-agents).
- **Node.js 20 or later** to run `npx kangentic`. The app itself does not need Node.
- **Git 2.26+** -- required for worktree support. Run `git --version` to check.
- **macOS 13 (Ventura) or later** on a Mac. Electron 44 does not start on macOS 12.

## Quick Install (Recommended)

```bash
npx kangentic
```

This downloads the pre-built binary for your platform, installs it, and launches the app. After the first run, the app updates itself. Windows and macOS install an update when you quit, and Linux installs it when you click **Restart to update**.

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
| Windows (x64) | `Kangentic-Setup-X.Y.Z.exe` | NSIS installer. Auto-updates. Runs on Windows on ARM under emulation. |
| macOS (Apple Silicon) | `Kangentic-X.Y.Z-arm64.dmg` | Drag to Applications. See [Gatekeeper note](#macos-gatekeeper). |
| macOS (Intel) | `Kangentic-X.Y.Z-x64.dmg` | Drag to Applications. The Knowledge Graph is unavailable on Intel Macs, see [below](#intel-macs). |
| Linux x64 (Debian/Ubuntu) | `kangentic_X.Y.Z_amd64.deb` | `sudo apt install ./kangentic_*.deb` |
| Linux x64 (Fedora/RHEL/openSUSE) | `kangentic-X.Y.Z-1.x86_64.rpm` | `sudo dnf install kangentic-*.rpm` |
| Linux arm64 (Debian/Ubuntu) | `kangentic_X.Y.Z_arm64.deb` | `sudo apt install ./kangentic_*.deb` |
| Linux arm64 (Fedora/RHEL/openSUSE) | `kangentic-X.Y.Z-1.aarch64.rpm` | `sudo dnf install kangentic-*.rpm` |

`npx kangentic` picks the right file itself. On a Mac it installs the Apple Silicon build even
when an Intel build of Node runs it under Rosetta.

### Windows

1. Download the `.exe` installer.
2. Run it -- the NSIS installer handles installation and creates a Start Menu shortcut.
3. If Windows SmartScreen warns about an unrecognized app, click **More info** then **Run anyway**. Releases are code-signed, but SmartScreen can still warn about a new release until enough people have downloaded it.
4. Auto-updates are built in. New versions install silently on restart.

### macOS

1. Download the `.dmg` for your Mac: `arm64` for Apple Silicon, `x64` for Intel.
2. Open it and drag Kangentic to your Applications folder.
3. Releases are signed and notarized, so macOS opens them normally. If Gatekeeper blocks the app anyway, see [Gatekeeper bypass](#macos-gatekeeper) below.

#### Intel Macs

Everything works on an Intel Mac except the Knowledge Graph. Its local model runs on
onnxruntime, which ships no Intel macOS build, so Settings > Knowledge Graph shows the feature as
unavailable and the app never downloads the model. The index and Quick Find still search your
conversations, tasks and commits by keyword.

#### macOS Gatekeeper

A build you made yourself is not notarized, and macOS blocks it on first launch:

1. Open **System Settings > Privacy & Security**.
2. Scroll to the bottom -- you'll see a message about Kangentic being blocked.
3. Click **Open Anyway**.
4. Alternatively, right-click the app in Finder, select **Open**, then click **Open** in the dialog.

### Linux

Install with your package manager:

```bash
# Debian/Ubuntu (on arm64: kangentic_X.Y.Z_arm64.deb)
sudo apt install ./kangentic_X.Y.Z_amd64.deb

# Fedora/RHEL (on arm64: kangentic-X.Y.Z-1.aarch64.rpm)
sudo dnf install kangentic-X.Y.Z-1.x86_64.rpm

# openSUSE (on arm64: kangentic-X.Y.Z-1.aarch64.rpm)
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
  - **Linux:** `build-essential` and `python3` (`sudo apt install build-essential python3`), needed only on an architecture node-pty ships no binary for (it ships x64 and arm64)

## Troubleshooting

### Agent CLI not found

Kangentic finds each agent CLI on your PATH and offers only the ones it finds. Check that the CLI you want answers its version command:

```bash
claude --version
codex --version
```

If the CLI is installed somewhere PATH does not reach, set its location in **Settings > Agent > CLI path**.

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

- On Linux, ensure `build-essential` and `python3` are installed (see [From Source](#from-source) above). node-pty compiles there only on an architecture it ships no binary for (it ships x64 and arm64).
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
