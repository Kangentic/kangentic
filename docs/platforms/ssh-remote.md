---
type: Reference
title: SSH remote hosts
description: "Running agents on a Linux host over SSH: the trust model, adding a host without a terminal (fingerprint, password once, key file, SSH config), the program Kangentic installs on the host and how npm run build:host makes it, how a drop, a quit and a restart behave, how a remote project differs from a local one, which agents run there, and the known limits."
tags: [ssh, remote, hosts, helper, beta]
sources:
  - resource: src/main/remote/remote-host-service.ts
  - resource: src/main/remote/ssh-host-admin.ts
  - resource: src/main/remote/ssh-setup.ts
  - resource: src/main/remote/host-status.ts
  - resource: src/main/remote/host-assets.ts
  - resource: src/main/remote/link/host-installer.ts
  - resource: src/main/remote/link/link-hub.ts
  - resource: src/main/remote/host-router.ts
  - resource: src/main/remote/remote-launch.ts
  - resource: src/main/remote/remote-session-relay.ts
  - resource: src/main/remote/helper/helper-server.ts
  - resource: src/main/remote/helper/host-command.ts
  - resource: src/main/remote/host-file-sync.ts
  - resource: src/main/agent/shared/remote-files.ts
  - resource: scripts/build-host.mjs
  - resource: scripts/lib/deterministic-tar.mjs
  - resource: scripts/verify-host-manifest.js
  - resource: src/renderer/components/settings/tabs/SshTab.tsx
  - resource: src/renderer/components/dialogs/AddProjectDialogs.tsx
  - resource: .claude/rules/ssh-remote.md
---
# SSH remote hosts

**Beta.** The feature is labelled Beta until it has run on a real host for Claude Code and Cursor. Today only Claude Code runs on a host, and no build installs the host program for a user yet (see [Known limits](#known-limits)).

Kangentic can run an agent on a Linux machine over SSH. The repo, the agent, its edits, builds and tests all stay on the host. This computer runs the UI and the board and needs no clone, no local CLI and no local login for that project.

## Trust

A host is trusted like this computer. Its agents get the same MCP tools as a local agent, across every project, and nothing about a host is allowlisted. Adding a host is the trust step, and removing it ends its access. A host's agents can reach every project on the board, as a local agent can.

The host never connects to Kangentic's MCP server, which listens on this computer's loopback address only: each MCP message crosses the link as a file and this computer posts it. The MCP token is on the host all the same. The agent's MCP config in the session folder holds it, owner-only, because the agent's bridge sends it with every request, and the relay posts with the token the request names. That gives a host nothing it did not already have, since anything that can write the session's hook folder can ask for the same calls. The token is useless off this computer, because only its loopback server accepts it.

## The ssh program

Kangentic runs the `ssh` on this computer. On Windows it prefers Windows' own OpenSSH (`System32\OpenSSH`) over whichever `ssh` is first on PATH, because Git for Windows' build is an MSYS program that names its files `/c/Users/dev/.ssh/known_hosts`, which a Windows program reads as `C:\c\Users\dev\...`. That mistake once pinned a host key into a folder created at the drive root, so `ssh` found no pin and waited on a host-key question nobody could answer. Both programs read the same `~/.ssh` folder. Where Windows' OpenSSH is missing, the name on PATH is used and an MSYS-style path is converted back. Elsewhere the name on PATH is what a terminal would run.

Every `ssh` Kangentic starts for setup has its stdin closed. Windows' `ssh` forwards stdin to the remote command, and an open pipe left it waiting after the command had finished.

## Adding a host

Settings > SSH > Add host runs in the card, with no terminal.

1. **Name and address.** The address is what `ssh` is given: `user@host`, or a name from the user's SSH config, which is also where a jump host, a port or a certificate is set.
2. **The host key.** Kangentic learns the key the host presents with a throwaway connection and shows its fingerprint once. Trusting it records it in the user's own `known_hosts`, so a terminal `ssh` agrees. If the host's key later changes, the connection is refused with ssh's own warning and the host's row offers **Forget old key**, which removes only that entry.
3. **How to sign in.**
   - *My SSH config* uses the user's own config, agent and keys, exactly as a terminal does.
   - *Key file* copies the chosen private key into Kangentic's own folder with owner-only permissions (a downloaded key has a mode `ssh` refuses).
   - *Password* is used once, to add a key Kangentic creates for the host (ed25519, no passphrase, in Kangentic's folder). The password is never stored. Removing the host deletes the key and, when the host can be reached, its line in `authorized_keys`.

Kangentic never asks for a passphrase. A key with a passphrase must be in the user's SSH agent, or the host takes the password step. A reconnect never prompts: `ssh` runs with `BatchMode=yes`, so a host that needs input fails with ssh's own words, shown as given.

A step that fails undoes the steps before it. When the password step fails, Kangentic also tries to take the key it made off the host before deleting its own copy, because the key may have reached the host before the failure. A host whose only problem is that it cannot be connected stays in the list with the reason, so it can be fixed and retried.

## The program on the host

Kangentic installs a small program on the host under `~/.kangentic/host/<version>/`: a pinned Node, a bundle that runs the same PTY code the desktop runs, and node-pty's Linux prebuild. The version is the app's own. It runs as a daemon behind a unix socket, so it outlives any one connection, and `ssh` only carries bytes to it.

- The app streams its own copy over the connection (the host needs nothing from the internet), and the host checks the SHA-256 before it unpacks anything. A version already complete there is not sent again.
- The host must be Linux on x86_64 or arm64 with glibc 2.28 or newer. Alpine and other musl hosts are refused with a sentence saying what the host is.
- `npm run build:host` builds the program on any OS into `dist/host`: one tarball per CPU and a `manifest.json`. A development build reads it from there. The app refuses a manifest whose version is not its own, whose file names leave the folder, whose checksums are not lowercase SHA-256, or whose download addresses are not https.
- A tarball is written by Kangentic's own tar writer (`scripts/lib/deterministic-tar.mjs`) so the same files always give the same bytes: sorted entries, one fixed time, owner root, a fixed gzip header. The checksum in an installer therefore matches the archive on the release however many times the release workflow runs.

## Connection state

Each host is Connecting, Connected, Reconnecting or Unreachable. A connection that has not come up for about 20 seconds reads as Unreachable, with the link's own words as the reason, and the link keeps retrying underneath. Unreachable is not gone: every agent on the host keeps running.

A remote project shows its host as a 20 by 20 square after its name in the project list: a server icon when connected, a grey spinner while reconnecting, a red warning when unreachable. A strip above the board appears only while the open project's host is not connected, says its agents keep running, and offers Reconnect once the host is unreachable.

## A drop, a quit and a restart

- **A drop keeps the agent running.** The link reports a state, never an exit. When the connection returns Kangentic reattaches, replaying what it missed from the last acknowledged offset.
- **Quit suspends**, as it does locally, with one message to the program on the host. The quit waits for that message to leave.
- **A restart with the host out of reach leaves a remote task paused and resumable.** Recovery needs the host's details before it can build the resume, so with the link down the task keeps its paused card and the user resumes it once the host is back. A spawn that throws for a remote task is kept resumable too, where a local one is retired.
- **Only the host proves a path absent.** A host path is checked by the host's own program, never by this computer's disk or a mirror of it, and a failed ask is an error, never "absent". Nothing is pruned, demoted or deleted for want of a path while the link is down.

## Remote projects

Add project asks where first once a host exists: This computer, or a host. A host opens a form for the folder on it, which Kangentic checks on the host. The project is a local shell folder (under Kangentic's config folder) plus a host and a folder.

- The board, tasks, history and settings are the local database as ever.
- A remote project runs **without git worktrees** for now: the shell folder is not a repository, so each task works in the host folder directly. The Changes panel, PR linking and branch features are off for it.
- Kangentic adds `.kangentic/` to the host repository's `.git/info/exclude`, so its runtime folder stays out of `git status` there.
- Removing a host removes its projects from Kangentic, suspends their agents and leaves the folders on the host.

## Files an agent edits on a host

An agent's trust, hook and MCP code was written for files on this computer: it merges Kangentic's entry into the user's `~/.gemini/trustedFolders.json` or `<project>/.cursor/mcp.json` and strips it when the session ends. For a CLI on a host those files are on the host, so an adapter does not rewrite that code. It declares the files (`AgentAdapter.remoteFiles()`: paths relative to the CLI's home, paths relative to the project, and which of them hold a secret), and `HostFileSync` (`src/main/remote/host-file-sync.ts`) does the rest:

1. **Pull.** Before `ensureTrust` runs, each declared file is read from the host into the folder the adapter's code already edits: the CLI's home becomes a local mirror folder, the project becomes its local shell folder. A file the host does not have removes the local copy, so a stale one is never sent back.
2. **Run.** The adapter's trust and command builder run unchanged, merging into the user's own entries.
3. **Push.** After the command is built, every file that differs from what the host had is written there (executable for `*.sh`, owner-only for the home and for files an adapter marks private, readable otherwise). A file the host changed in the meantime is not overwritten: the spawn fails and says so.
4. **Restore.** When the session releases, the adapter strips its entries from the local copy and the strip is pushed, so the host's file goes back to what the user had. A host that cannot be reached keeps the files until the next session there.

A project file Kangentic creates on the host is added to the host's `.git/info/exclude`, so it stays out of `git status` and out of an agent's `git add -A`. A file larger than the helper reads whole (1 MB) is refused rather than edited cut short.

The session's own folder on the host (`<project>/.kangentic/sessions/<id>`) holds the settings, the MCP config and the hook script the relay pushes, plus any extra files an agent names (`remoteSessionFiles()`, such as Copilot's config folder). The relay removes the files it pushed when the session is released.

A probe an agent's CLI answers (its hook trust, a chat id, a model list) runs on the host: the helper starts the program through the user's own shell so its PATH applies, brackets its output so a banner printed by `.bashrc` cannot corrupt a JSON answer, and stops its whole process group at the timeout. A shell that cannot run the script (fish, nushell, csh) is replaced by `sh -lc`, which sees only the login PATH.

## Agents

All 14 adapters that declare `supportsWslCli` declare `remoteCliName` and run on a host. **None has run on a real host with its real CLI**: every one is covered by unit tests against a fake host, and the mock CLIs on a Docker host have exercised the path end to end (see below). Real CLIs are the Beta gate.

What is not available over SSH for any agent yet: the transcript and conversation viewer, token and cost figures read from the CLI's own session files, and the session-id pass that reads those files. They read this computer's disk, which holds nothing of the host's, and they degrade to nothing without errors. A session id still arrives from the agent's hooks or its output where the adapter has one.

An agent that cannot run on a host fails the spawn with a sentence saying so.

## Known limits

- **The release path for the host program has not run yet.** A development build uses `npm run build:host`. An installed build reads `resources/host/manifest.json` and downloads the one archive its host's CPU needs from the release into `<config folder>/host-assets/<version>/` the first time it is needed, checks it against the manifest's SHA-256 and size, and only then sends it, so the installer grows by a few hundred bytes instead of about 90 MB. The release workflow's `build-host` job builds both archives, attaches them to the draft release and hands the manifest to every packaging leg, and each leg fails if its packaged `resources/host/manifest.json` is missing or for another version (`docs/releases/deployment.md`, "The host program"). The archives are byte-stable, so a re-run produces the same checksums. None of that has run in a real release yet: the first tagged build is its test, and the download is reachable only once the release is published. Until a build carries the manifest, a connect ends with "This build of Kangentic does not include the program to install on a host", shown on the host's row.
- **A host with `KillUserProcesses=yes` ends the daemon with the login session that started it.** Phase 0 measured this (`docs/audits/ssh-remote-phase-0-audit.md`): only linger plus `systemd-run --user` keeps it. Kangentic does not detect the setting or change the host, so on such a host the agents end when the session that installed the program ends, and recovery treats them as lost. Enabling linger is the host owner's call.
- **`ssh` starts on the pty host's terminal thread** when a link dials or redials, which on Windows holds local terminals for one `CreateProcess`.
- **A remote session has no process-tree watching.** The background-shell watcher, the transcript readers and the session-id filesystem pass read this computer's disk, so they are off for a remote session until the read mirror lands.
- **A macOS client is unmeasured** for how an agent exits, as it is for local sessions.
- **System32 `ssh.exe` on Windows can lose bytes mid-stream.** Every frame is checksummed and a framing error ends the connection and resumes from the last acknowledged offset, so the loss costs a reconnect, not data.

The rules that keep a remote session from being treated as a process on this machine are in `.claude/rules/ssh-remote.md`, and the measurements behind the design are in `docs/audits/ssh-remote-phase-0-audit.md` and `docs/audits/ssh-remote-phase-1-audit.md`.
