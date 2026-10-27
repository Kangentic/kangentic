# Platforms

## Shells, paths and environment

* [Shells and paths](shells-and-paths.md) - Shell detection order per OS, how adaptCommandForShell and quoteArg quote for PowerShell, cmd, bash, fish, nushell and WSL, npm .cmd shim launching, Windows cwd fixups, WSL interop limits and agent CLIs installed in a WSL distro (paths, WSLENV, the hook transport, which agents run there), PTY environment stripping (CLAUDE_CODE_*, NO_COLOR, TERM), and config directory locations.

## Packaging

* [Packaging and security](packaging-and-security.md) - How native modules (better-sqlite3, node-pty, koffi, sqlite-vec, onnxruntime) are packaged and unpacked from the asar, the afterPack worker checks, Electron fuses, the NSIS ACL grant, the auto-update platform guard per OS, and the Linux deb and rpm dependencies.

## Per-OS behavior

* [Windows](windows.md) - Windows-only behavior: the AUMID that ties the taskbar icon to the installer shortcut, core.longpaths for worktrees, why MAX_PATH rarely binds and where it does (ninja, CMake), and how CHROME_CRASHPAD_PIPE_NAME is kept from terminal children.
* [macOS](macos.md) - macOS-only behavior: the hidden title bar and traffic lights, hardened runtime entitlements and notarization, and the custom node-pty spawn-helper that clears mach exception ports so terminal children do not report crashes to Kangentic's Crashpad.

## Failure recovery

* [GPU process failures](gpu-failures.md) - Why an unusable GPU process kills the browser process (Chromium's fallback ladder, Linux zygote launch failures), why --disable-gpu alone does not help, and how the --in-process-gpu recovery, gpu-health.json records and the graphicsAccelerationEnabled setting work.
