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
  - resource: scripts/build-host.mjs
  - resource: src/renderer/components/settings/tabs/SshTab.tsx
  - resource: src/renderer/components/dialogs/AddProjectDialogs.tsx
  - resource: .claude/rules/ssh-remote.md
---
# SSH remote hosts

**Beta.** The feature is labelled Beta until it has run on a real host for Claude Code and Cursor. Today only Claude Code runs on a host, and no build installs the host program for a user yet (see [Known limits](#known-limits)).

Kangentic can run an agent on a Linux machine over SSH. The repo, the agent, its edits, builds and tests all stay on the host. This computer runs the UI and the board and needs no clone, no local CLI and no local login for that project.

## Trust

A host is trusted like this computer. Its agents get the same MCP tools as a local agent, across every project, over a relay on this computer: the token never leaves, and nothing about a host is allowlisted. Adding a host is the trust step, and removing it ends its access. A host's agents can reach every project on the board, as a local agent can.

## Adding a host

Settings > SSH > Add host runs in the card, with no terminal.

1. **Name and address.** The address is what `ssh` is given: `user@host`, or a name from the user's SSH config, which is also where a jump host, a port or a certificate is set.
2. **The host key.** Kangentic learns the key the host presents with a throwaway connection and shows its fingerprint once. Trusting it records it in the user's own `known_hosts`, so a terminal `ssh` agrees. If the host's key later changes, the connection is refused with ssh's own warning and the host's row offers **Forget old key**, which removes only that entry.
3. **How to sign in.**
   - *My SSH config* uses the user's own config, agent and keys, exactly as a terminal does.
   - *Key file* copies the chosen private key into Kangentic's own folder with owner-only permissions (a downloaded key has a mode `ssh` refuses).
   - *Password* is used once, to add a key Kangentic creates for the host (ed25519, no passphrase, in Kangentic's folder). The password is never stored. Removing the host deletes the key and, when the host can be reached, its line in `authorized_keys`.

Kangentic never asks for a passphrase. A key with a passphrase must be in the user's SSH agent, or the host takes the password step. A reconnect never prompts: `ssh` runs with `BatchMode=yes`, so a host that needs input fails with ssh's own words, shown as given.

A step that fails undoes the steps before it. A host whose only problem is that it cannot be connected stays in the list with the reason, so it can be fixed and retried.

## The program on the host

Kangentic installs a small program on the host under `~/.kangentic/host/<version>/`: a pinned Node, a bundle that runs the same PTY code the desktop runs, and node-pty's Linux prebuild. The version is the app's own. It runs as a daemon behind a unix socket, so it outlives any one connection, and `ssh` only carries bytes to it.

- The app streams its own copy over the connection (the host needs nothing from the internet), and the host checks the SHA-256 before it unpacks anything. A version already complete there is not sent again.
- The host must be Linux on x86_64 or arm64 with glibc 2.28 or newer. Alpine and other musl hosts are refused with a sentence saying what the host is.
- `npm run build:host` builds the program on any OS into `dist/host`: one tarball per CPU and a `manifest.json`. A development build reads it from there. The app refuses a manifest whose version is not its own.

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

## Agents

| Agent | Runs on a host | Run on a real host |
| --- | --- | --- |
| Claude Code | Yes | Not yet |
| The other 13 that declare `supportsWslCli` | Not yet (Phase 4) | No |

An agent that cannot run on a host fails the spawn with a sentence saying so.

## Known limits

- **No packaged build carries the host program yet.** A development build uses `npm run build:host`. Until the release build includes it, a connect from an installed build ends with "This build of Kangentic does not include the program to install on a host", shown on the host's row. How it ships (inside the installer, or downloaded on first use against a checksum the app carries) is undecided.
- **A host with `KillUserProcesses=yes` ends the daemon with the login session that started it.** Phase 0 measured this (`docs/audits/ssh-remote-phase-0-audit.md`): only linger plus `systemd-run --user` keeps it. Kangentic does not detect the setting or change the host, so on such a host the agents end when the session that installed the program ends, and recovery treats them as lost. Enabling linger is the host owner's call.
- **`ssh` starts on the pty host's terminal thread** when a link dials or redials, which on Windows holds local terminals for one `CreateProcess`.
- **A remote session has no process-tree watching.** The background-shell watcher, the transcript readers and the session-id filesystem pass read this computer's disk, so they are off for a remote session until the read mirror lands.
- **A macOS client is unmeasured** for how an agent exits, as it is for local sessions.
- **System32 `ssh.exe` on Windows can lose bytes mid-stream.** Every frame is checksummed and a framing error ends the connection and resumes from the last acknowledged offset, so the loss costs a reconnect, not data.

The rules that keep a remote session from being treated as a process on this machine are in `.claude/rules/ssh-remote.md`, and the measurements behind the design are in `docs/audits/ssh-remote-phase-0-audit.md` and `docs/audits/ssh-remote-phase-1-audit.md`.
