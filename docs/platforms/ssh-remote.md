---
type: Reference
title: SSH remote hosts
description: "Running agents on a Linux host over SSH: the trust model, adding a host without a terminal (fingerprint, password once, key file, SSH config), the program Kangentic installs on the host and how npm run build:host makes it, how a drop, a quit and a restart behave, how a remote project differs from a local one, how a dev server's port reaches this computer, which agents run there, and the known limits."
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
  - resource: src/main/remote/link/port-forward.ts
  - resource: src/main/remote/port-forward-plan.ts
  - resource: src/main/remote/helper/listening-ports.ts
  - resource: src/main/remote/helper/program-versions.ts
  - resource: src/main/remote/helper/file-tail.ts
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
- The helper answers `programInfo` (its version, when it started, how many terminals it holds, which versions sit on the host). A connected host's row in Settings > SSH shows it as "Program 0.53.0 | 2 terminals running", and says "(this app is 0.54.0)" when the running program is older than the app. That happens after an update: the daemon outlives the app, so a new connection joins the old daemon and the old version keeps running until it is stopped. Kangentic has no Update or Stop button yet, because ending the daemon ends every agent on the host.
- Old versions are pruned. When a host's link first comes up in a run, Kangentic asks the helper to remove versions installed more than 30 days ago, never the running one and never this app's. The relay command touches its version's `.complete` marker each time it starts, so a version another computer on the same account still connects with stays fresh and is not taken by this one.
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

## Dev servers on a host

An agent on a remote project reserves a dev-server port with `kangentic_reserve_dev_ports`, as on any project, and starts its server on the host at that number. Kangentic then carries the port to the same number on this computer, so `http://localhost:<port>` here and the Browser pane reach it.

- **What is forwarded.** The ports reserved by tasks of the host's projects (the dev-port ledger), and only those. Kangentic works out the set from the ledger and the project rows each time it changes, so a deleted task, project or host stops its forward too (`src/main/remote/port-forward-plan.ts`).
- **When.** Not at reservation. The host's program reports which ports listen on loopback or the wildcard address (`listeningPorts`, read from `/proc/net/tcp` and `/proc/net/tcp6`), asked every 2 seconds while a wanted port has no forward yet. A forward starts when its server first listens, usually within a few seconds of the server starting, and stays until the port is no longer wanted. A stopped server leaves an idle listener here, so restarting a server does not rebuild the forward.
- **How.** One `ssh -N -L 127.0.0.1:<port>:localhost:<port>` per port, with the host's own connection options and key (`src/main/remote/link/port-forward.ts`), started by the process that holds the links. It is a separate `ssh`, not a channel of the link: a running `ssh` cannot take another forward on Windows (no `ControlMaster`), and a dev server's traffic would otherwise share one stream with the terminals' keystrokes. The listener is bound to 127.0.0.1 only, and named explicitly because `ExitOnForwardFailure` does not reliably fail for a half-taken `localhost` bind. The far end is `localhost`, so a server on `::1` (Vite's default) is reached too.
- **Failures.** A port already held on this computer is reported without starting `ssh`. An `ssh` that exits while its port is still wanted is started again after 2 seconds, doubling to 30. `kangentic_check_dev_ports` tells the agent, per port, whether it is forwarding, waiting for a server, or blocked and why.
- **Measured** on this computer's `ssh.exe` against a real `sshd`: a server on the host was reachable at `127.0.0.1` here 0.6 seconds after the first poll, a port held locally was reported blocked and then forwarded once freed, and no `ssh` was left running after the port was dropped or the forwarder was disposed.

## Files an agent edits on a host

An agent's trust, hook and MCP code was written for files on this computer: it merges Kangentic's entry into the user's `~/.gemini/trustedFolders.json` or `<project>/.cursor/mcp.json` and strips it when the session ends. For a CLI on a host those files are on the host, so an adapter does not rewrite that code. It declares the files (`AgentAdapter.remoteFiles()`: paths relative to the CLI's home, paths relative to the project, and which of them hold a secret), and `HostFileSync` (`src/main/remote/host-file-sync.ts`) does the rest:

1. **Pull.** Before `ensureTrust` runs, each declared file is read from the host into the folder the adapter's code already edits: the CLI's home becomes a local mirror folder, the project becomes its local shell folder. A file the host does not have removes the local copy, so a stale one is never sent back.
2. **Run.** The adapter's trust and command builder run unchanged, merging into the user's own entries.
3. **Push.** After the command is built, every file that differs from what the host had is written there (executable for `*.sh`, owner-only for the home and for files an adapter marks private, readable otherwise). A file that already existed keeps the permission bits and the symlink it had. A file the host changed in the meantime is not overwritten: the spawn fails and says so. The helper repeats the check as it swaps the file in, so a save by the user in the instant after Kangentic's own look is refused too.
4. **Restore.** When the session releases, the adapter strips its entries from the local copy and the strip is pushed, so the host's file goes back to what the user had. A host that cannot be reached keeps the files, and the next session there strips them, because the adapters strip Kangentic's entries by what they are, not by which session wrote them.

Several sessions on one host share these files (every task in a remote project works in one folder, and the CLI's home is one folder). Two things keep them from undoing each other. A pull does not rewrite a folder copy another spawn has pulled and not yet pushed, and a push compares the host with what Kangentic last knew it to hold, which every session on the host updates, not with that session's own pull. A release that is the last to end therefore strips the entries of the sessions that ended before it.

A project file Kangentic creates on the host is added to the host's `.git/info/exclude`, so it stays out of `git status` and out of an agent's `git add -A`. A file larger than the helper reads whole (1 MB) is refused rather than edited cut short. A `.json` file the host holds that is not plain JSON (a settings file with comments) is never rewritten: the adapter would have started from an empty one and replaced everything in it, so the spawn fails and names the file.

The session's own folder on the host (`<project>/.kangentic/sessions/<id>`) holds the settings, the MCP config and the hook script the relay pushes, plus any extra files an agent names (`remoteSessionFiles()`, such as Copilot's config folder). The relay removes the files it pushed when the session is released.

A probe an agent's CLI answers (its hook trust, a chat id, a model list) runs on the host: the helper starts the program through the user's own shell so its PATH applies, brackets its output so a banner printed by `.bashrc` cannot corrupt a JSON answer, and stops its whole process group at the timeout. A shell that cannot run the script (fish, nushell, csh) is replaced by `sh -lc`, which sees only the login PATH.

## Agents

All 15 adapters that declare `supportsWslCli` declare `remoteCliName` and run on a host. **None has run with its real CLI.** Each is covered by unit tests against a fake host. The mock CLIs of the first 14 have run on a real sshd in a Docker container through the real app (Kimi Code joined after that run, so it has only the unit tests). That run added the host over ssh with a password, made a remote project, and started tasks for 14 agents (eight at once in one host folder). It confirmed, for the agents that start there:

- the agent runs on the host under the host program's own Node, and its trust, settings and MCP files are written there with hook paths of the host;
- a file the user already had (`.gemini/settings.json`, `.cursor/mcp.json`, `~/.gemini/trustedFolders.json`) keeps its own entries beside Kangentic's;
- a project file Kangentic creates is added to the host's `.git/info/exclude`, and one the user had is not;
- moving the tasks away puts every file back as the user had it, removes the files that were not theirs, and removes the session folders;
- a hook fired on the host reaches this computer's event log, in order.

Real CLIs are the Beta gate: the mocks do not run hooks themselves, ask for a login, or draw a real TUI, and the real Codex hook-trust read and Cursor's `create-chat` have only met fakes.

### Transcripts

The conversation viewer, the search index and the token and cost ledger read a conversation's transcript from this computer's disk. For a session on a host, Kangentic keeps a copy of the transcript there. The adapter names the file (`remoteTranscriptFiles()`, as the path its own readers build under this computer's mirror of the host's home, `<config folder>/remote-homes/<host>/`), the helper tails the host's file by byte offset (`helper/file-tail.ts`, a poll every 250 ms), and the relay writes each chunk at the same offset into the copy (`RemoteSessionRelay.deliverChunk`). A reader that opens the transcript file (the conversation viewer, the search index) then finds a remote conversation where it finds a local one, and a path the CLI reports under the host's home (the status line's `transcript_path`) maps into the copy too. The live telemetry on the card (cost, context) is not from this: it comes from the status line the hooks carry, as it did before. The reader that follows the transcript for model and token figures while a session runs (`SessionHistoryReader`) stays off for a remote session, because a resumed session's backfill would read as fresh usage.

- **Claude Code is the one agent that does this so far.** Its transcript is the one file it appends to under `~/.claude/projects/<slug>/`, filed under the slug of the folder on the host. Subagent transcripts are not carried. The other adapters have not declared a transcript file, so for them the viewer, the index and the token ledger are empty, and a session id still arrives from the agent's hooks or its output where the adapter has one.
- **A resume copies the whole file first.** The copy starts from byte 0 each session, at a few chunks a scan (about 1 MB a second) so it shares the link with the terminal instead of crowding it. A transcript of tens of megabytes takes under a minute to arrive, and the viewer fills in as it does. The last pass when a session is released is not paced, so the end of the conversation is in the copy when the session is.
- **The copy never proves anything gone.** It is empty until the first bytes arrive and stale while the link is down, so no reader may treat a missing or old copy as "the conversation does not exist". A resume still asks the host (`resume-conversation-guard.ts` answers `unknown` for a host, and nothing is demoted for want of a file).
- **A file the agent replaces or shortens is copied again from the start.** The copy is emptied first.
- **A conversation that forks is not followed.** Claude's `/clear` starts a new conversation id in a new file, and only the file named at spawn is tailed, so the viewer stops updating at the fork until the session is next started.
- **Removing a host deletes its copy.**

An agent that cannot run on a host fails the spawn with a sentence saying so.

## Known limits

- **The release path for the host program has not run yet.** A development build uses `npm run build:host`. An installed build reads `resources/host/manifest.json` and downloads the one archive its host's CPU needs from the release into `<config folder>/host-assets/<version>/` the first time it is needed, checks it against the manifest's SHA-256 and size, and only then sends it, so the installer grows by a few hundred bytes instead of about 90 MB. The release workflow's `build-host` job builds both archives, attaches them to the draft release and hands the manifest to every packaging leg, and each leg fails if its packaged `resources/host/manifest.json` is missing or for another version (`docs/releases/deployment.md`, "The host program"). The archives are byte-stable, so a re-run produces the same checksums. None of that has run in a real release yet: the first tagged build is its test, and the download is reachable only once the release is published. Until a build carries the manifest, a connect ends with "This build of Kangentic does not include the program to install on a host", shown on the host's row.
- **A host with `KillUserProcesses=yes` ends the daemon with the login session that started it.** Phase 0 measured this (`docs/audits/ssh-remote-phase-0-audit.md`): only linger plus `systemd-run --user` keeps it. Kangentic does not detect the setting or change the host, so on such a host the agents end when the session that installed the program ends, and recovery treats them as lost. Enabling linger is the host owner's call.
- **`ssh` starts on the pty host's terminal thread** when a link dials or redials, which on Windows holds local terminals for one `CreateProcess`.
- **Only reserved ports are forwarded.** A server an agent starts on a port it did not reserve with `kangentic_reserve_dev_ports` is not reachable from this computer. A panel that lists the host's ports and forwards them on a click is not built.
- **A crash of the process holding the links can leave a forward's `ssh` running,** holding its local port. The next forward of that port then shows as blocked, with the port named as in use on this computer. End the stray `ssh`, or restart the computer.
- **A host whose `sshd` sets `AllowTcpForwarding no` cannot forward.** The port shows as blocked with `ssh`'s own refusal.
- **A remote project's folder must be inside the user's home on the host.** The helper reads and writes only beneath the home, so a folder such as `/srv/app` is refused when it is added, with the home it must be in. Link or move the project under the home to use it.
- **Tasks in a remote project share one folder.** There are no worktrees, so two agents edit the same files. The Add project form says so.
- **A remote session has no process-tree watching.** The background-shell watcher and the session-id filesystem pass read this computer's disk, so they are off for a remote session. Transcripts are copied for Claude Code only (see Transcripts).
- **A macOS client is unmeasured** for how an agent exits, as it is for local sessions.
- **System32 `ssh.exe` on Windows can lose bytes mid-stream.** Every frame is checksummed and a framing error ends the connection and resumes from the last acknowledged offset, so the loss costs a reconnect, not data.

The rules that keep a remote session from being treated as a process on this machine are in `.claude/rules/ssh-remote.md`, and the measurements behind the design are in `docs/audits/ssh-remote-phase-0-audit.md` and `docs/audits/ssh-remote-phase-1-audit.md`.
