---
type: Reference
title: SSH remote hosts
description: "Running agents on a Linux host over SSH: the trust model, adding a host without a terminal (fingerprint, password once, key file, SSH config), the program Kangentic installs on the host and how npm run build:host makes it, how a drop, a quit and a restart behave, how a remote project differs from a local one, how a dev server's port reaches this computer, which agents run there, and the known limits."
tags: [ssh, remote, hosts, helper, beta]
sources:
  - resource: src/main/remote/remote-host-service.ts
  - resource: src/main/remote/ssh-host-admin.ts
  - resource: src/main/remote/ssh-config-hosts.ts
  - resource: src/main/ipc/helpers/hide-project.ts
  - resource: src/main/workflows/workflow-hidden-project.ts
  - resource: src/main/remote/ssh-setup.ts
  - resource: src/main/remote/host-status.ts
  - resource: src/main/remote/host-assets.ts
  - resource: src/main/remote/link/host-installer.ts
  - resource: src/main/remote/link/link-hub.ts
  - resource: src/main/remote/host-router.ts
  - resource: src/main/remote/remote-launch.ts
  - resource: src/main/remote/remote-session-relay.ts
  - resource: src/main/remote/host-paths.ts
  - resource: src/main/remote/host-transfer.ts
  - resource: src/main/remote/host-attachments.ts
  - resource: src/main/remote/host-script.ts
  - resource: src/main/remote/helper/helper-server.ts
  - resource: src/main/remote/helper/host-command.ts
  - resource: src/main/remote/host-file-sync.ts
  - resource: src/main/remote/link/port-forward.ts
  - resource: src/main/remote/port-forward-plan.ts
  - resource: src/main/remote/helper/listening-ports.ts
  - resource: src/main/remote/helper/program-versions.ts
  - resource: src/main/remote/helper/file-tail.ts
  - resource: src/main/remote/remote-worktrees.ts
  - resource: src/main/git/remote-worktree.ts
  - resource: src/main/git/remote-git.ts
  - resource: src/main/git/remote-git-probe.ts
  - resource: src/main/remote/host-git.ts
  - resource: src/main/git/diff-watcher.ts
  - resource: src/main/agent/shared/remote-files.ts
  - resource: src/main/agent/shared/cli-target.ts
  - resource: src/main/agent/adapters/goose/export-reader.ts
  - resource: src/main/agent/adapters/opencode/export-reader.ts
  - resource: scripts/build-host.mjs
  - resource: scripts/lib/deterministic-tar.mjs
  - resource: scripts/verify-host-manifest.js
  - resource: src/renderer/components/settings/tabs/SshTab.tsx
  - resource: src/renderer/components/dialogs/AddProjectDialogs.tsx
  - resource: src/renderer/components/dialogs/remote-directory.ts
  - resource: src/renderer/components/HostAddressInput.tsx
  - resource: src/renderer/components/host-address.ts
  - resource: .claude/rules/ssh-remote.md
---
# SSH remote hosts

**Beta.** The feature is labelled Beta until it has run on a real host for Claude Code and Cursor. Every adapter that declares `supportsWslCli` runs on a host (see [Agents](#agents)), and no build installs the host program for a user yet (see [Known limits](#known-limits)).

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
2. **The host key.** Kangentic learns the key the host presents with a throwaway connection and shows its fingerprint once. Trusting it records it in the user's own `known_hosts`, so a terminal `ssh` agrees. If the host's key later changes, the connection is refused with ssh's own warning and the host's row shows a key icon, **Trust new key**. It reads the key the host presents now and the fingerprint recorded before (`ssh-keygen -F`, left out when it cannot be read), and trusts nothing until the user confirms. On confirm the key is read again and must still carry the fingerprint shown, or nothing is changed. Then the old entry is removed (only that host's), the new one is recorded in the user's `known_hosts`, and the host reconnects. Forgetting the old key alone would leave the host unknown, and a reconnect never prompts, so the host could not be trusted again inside the app.
3. **How to sign in.**
   - *My SSH config* uses the user's own config, agent and keys, exactly as a terminal does.
   - *Key file* copies the chosen private key into Kangentic's own folder with owner-only permissions (a downloaded key has a mode `ssh` refuses). On Windows that is the protected ACL `ssh-keygen` gives a new key, because a file mode does nothing there and an inherited ACL can name another account, which `ssh` refuses too. The path is typed or pasted, or Choose opens the file dialog in the user's `.ssh` folder. A key that is not a private key, or has a passphrase, is refused when it is chosen (`ssh:checkKeyFile`), not when Add host is pressed.
   - *Password* is used once, to add a key Kangentic creates for the host (ed25519, no passphrase, in Kangentic's folder). The password is never stored. Removing the host deletes the key and, when the host can be reached, its line in `authorized_keys`.

Kangentic never asks for a passphrase. A key with a passphrase must be in the user's SSH agent, or the host takes the password step. A reconnect never prompts: `ssh` runs with `BatchMode=yes`, so a host that needs input fails with ssh's own words, shown as given.

A step that fails undoes the steps before it. When the password step fails, Kangentic also tries to take the key it made off the host before deleting its own copy, because the key may have reached the host before the failure. A host whose only problem is that it cannot be connected stays in the list with the reason, so it can be fixed and retried.

## The program on the host

Kangentic installs a small program on the host under `~/.kangentic/host/<version>/`: a pinned Node, a bundle that runs the same PTY code the desktop runs, and node-pty's Linux prebuild. The version is the app's own. It runs as a daemon behind a unix socket, so it outlives any one connection, and `ssh` only carries bytes to it.

- The app streams its own copy over the connection (the host needs nothing from the internet), and the host checks the SHA-256 before it unpacks anything. A version already complete there is not sent again.
- The host must be Linux on x86_64 or arm64 with glibc 2.28 or newer. Alpine and other musl hosts are refused with a sentence saying what the host is.
- `npm run build:host` builds the program on any OS into `dist/host`: one tarball per CPU and a `manifest.json`. A development build reads it from there. The app refuses a manifest whose version is not its own, whose file names leave the folder, whose checksums are not lowercase SHA-256, or whose download addresses are not https.
- The helper answers `programInfo` (its version, when it started, how many terminals it holds, which versions sit on the host). A connected host's row in Settings > SSH shows the version ("Program 0.53.0") beside the terminal count ("2 terminals running"), and says "(this app is 0.54.0)" when the running program is older than the app. That happens after an update: the daemon outlives the app, so a new connection joins the old daemon and the old version keeps running until it is stopped. Kangentic has no Update or Stop button yet, because ending the daemon ends every agent on the host.
- Old versions are pruned. When a host's link first comes up in a run, Kangentic asks the helper to remove versions installed more than 30 days ago, never the running one and never this app's. The relay command touches its version's `.complete` marker each time it starts, so a version another computer on the same account still connects with stays fresh and is not taken by this one.
- A tarball is written by Kangentic's own tar writer (`scripts/lib/deterministic-tar.mjs`) so the same files always give the same bytes: sorted entries, one fixed time, owner root, a fixed gzip header. The checksum in an installer therefore matches the archive on the release however many times the release workflow runs.

## Connection state

Each host is Connecting, Connected, Reconnecting or Unreachable. A connection that has not come up for about 20 seconds reads as Unreachable, with the link's own words as the reason, and the link keeps retrying underneath. Unreachable is not gone: every agent on the host keeps running.

A remote project shows its host as a 20 by 20 square after its name in the project list: a server icon when connected, a grey spinner while reconnecting, a red warning when unreachable. A strip above the board appears only while the open project's host is not connected, says its agents keep running, and offers Reconnect once the host is unreachable.

## A drop, a quit and a restart

- **A drop keeps the agent running.** The link reports a state, never an exit. When the connection returns Kangentic reattaches, replaying what it missed from the last acknowledged offset.
- **A launch with the network down tries the host again by itself.** Setting a host up installs its program over `ssh` before any link exists, and a link redials only once one does. A start nobody asked for (launch, a restart of the pty host) that fails because of the network is tried again after 5 seconds, then 10, 20 and 40, then every minute, with the row staying Unreachable and its reason updating (`remote/connect-retry.ts`, `remote-hosting.ts`). A refused sign-in, a changed host key, an invalid address, a build with no program and a host whose glibc is too old are never retried: they fail the same way each time, and a timer would only get the user banned by the host's fail2ban. The retry stops when the host connects, is removed, is held for removal, or someone presses Reconnect.
- **A drop is not silence.** No hook and no output can cross while the link is down, so the stale-thinking watchdog (180 seconds) and the idle timeout wait for a session on that host instead of reading the quiet as a stuck or idle agent. `SessionManager` keeps the hosts whose link is not connected (`isActivityHeld`, `isIdleTimeoutExempt`). When the link returns, the time it was down is wiped from the idle and liveness clocks of that host's running sessions (`noteLinkRestored`), so nothing is paused or forced idle for the outage.
- **Quit suspends**, as it does locally, with one message to the program on the host. The quit waits for that message to leave.
- **A restart with the host out of reach leaves a remote task paused and resumable.** Recovery needs the host's details before it can build the resume, so with the link down the task keeps its paused card. A spawn that throws for a remote task is kept resumable too, where a local one is retired.
- **The first time a host's link comes up in a run, its paused tasks resume on their own.** The hosts connect after the window, so a project opened at launch can run its recovery while its host is still dialing. When the link connects, the projects on that host whose recovery already ran run it again: the resume and the first spawn only, no sweep. A project opened later finds the link up. A reconnect after a drop does nothing, because what was running never paused.
- **Only the host proves a path absent.** A host path is checked by the host's own program, never by this computer's disk or a mirror of it, and a failed ask is an error, never "absent". Nothing is pruned, demoted or deleted for want of a path while the link is down.

## Remote projects

Add project asks where first once a host exists: This computer, or a host. A host opens a form for the folder on it, which Kangentic checks on the host. The project is a local shell folder (under Kangentic's config folder) plus a host and a folder.

- The board, tasks, history and settings are the local database as ever.
- **A task gets its own git worktree on the host** when the project's folder there is the top of a git repository with a commit, and worktrees are on for the project and the task (the same switches as a local project). See [Worktrees on a host](#worktrees-on-a-host). Any other folder is shared by every task, so run one agent in it at a time. PR linking and the branch switcher are still off for a remote project. The Changes panel and the branch header read the host, as [Git reads on a host](#git-reads-on-a-host) says.
- Kangentic adds `.kangentic/` to the host repository's `.git/info/exclude`, so its runtime folder stays out of `git status` there.
- **Remove hides, and deletes nothing.** Removing a host suspends its projects' agents, takes the key Kangentic made off the host and deletes it here, and hides the projects everywhere (sidebar, search, the MCP tools). When the open project was one of them, the most recently opened project that is left opens in its place, so the theme that applies is that project's own and not the app-wide default. The host row stays in the database, marked `removed_at`, with its projects' boards, tasks, shell folders and the copy of the host's transcripts. Nothing on the host is touched except that key.
- **Adding the same address again brings them back.** The address is matched case-insensitively on the host part. That restores the removed row under its old id, so each project's host still points at it and each keeps its directory. The projects are activated once the host connects, and what they had running resumes. A different address is a new host, and a different directory on a host is a new project. If the add fails after the row was restored, the row is marked removed again, so the projects stay hidden.
- **Hidden is not deleted, so a sweep reads every row.** `list`, `getById` and `getLastOpened` leave a hidden project out. Anything that reads "not in the list" as "gone" uses `listIncludingHidden`, `listHidden`, `isHidden` or `listOnHost`: the browser jar sweep, a project delete's count of a workflow's survivors, and the lookups that decide whether a folder is a remote project's. A hidden project still resolves as remote, so a start already on its way is refused with a sentence and never runs in its empty folder here.
- **A workflow with tasks on a hidden project pauses, and stays paused.** Remove pauses it before the host goes. The picker says which project holds it, an agent reading it is told, and Resume is refused until the host is added again. Then Resume is the user's: it does not resume by itself. It cannot complete while those tasks are hidden, and a link to one is held, not dropped.
- **Adding it back ends what the host still runs first.** A Remove with the link down cannot stop its agents, so before any project starts, the sessions the host's program still holds for these projects are hung up and waited for. Otherwise a resume would run a second agent on the same conversation. If the host cannot say, nothing starts, and the next connection tries again. The row keeps this (`reveal_pending`), so a restart before that connection waits for it too.
- **Clear data is the only local delete.** It is a button on a host's row in any connection state, shown only while the host has projects. It stops their running agents and deletes the boards, tasks, history, shell folders and transcript copy of that host's projects, and leaves the host in the list with none. It works with the host down. Their files on the host stay. One project that cannot be deleted stops none of the others: it is named in the error, and the transcript copy stays while it is left to read it.
- **Edit a host in place.** The pencil on a row edits its name, address and sign-in. A name saves at once. A new address first shows the key it presents and is saved only after the user trusts it. An address already used by another host, or by a removed one (whose projects it would shadow), is refused. A key Kangentic made belongs to the old machine, so a new address needs a new sign-in. Before anything is taken away, a real `ssh` in BatchMode signs in to the new address with the new sign-in. If that fails, the error is ssh's own words and the address, keys and row stay as they were. Only then does a key Kangentic made come off the old address, because on a host with passwords off it may be the only way in. A key file the user chose is never touched on the host. An address or sign-in change is refused while terminals run on the host, because the link restarts.
- **The Directory field suggests and browses.** In Add project on a host, typing lists the folders of the directory typed so far (`~/` is the host's home) and narrows them by the rest. Browse shows the same listing as a navigable list with a breadcrumb and a git tag. The listing is one fixed `sh` script through the helper's command runner, with the path as an argument, so no protocol change is needed. A directory that is not there reads as not existing, a path outside home is not listed, and a host that cannot be asked is an error shown in place, never an empty list.
- **Add host suggests names from `~/.ssh/config`.** The address field offers the `Host` names of this computer's SSH config, skipping wildcard patterns and negations and following `Include`.

## What an agent's tools report

A remote task has two folders that look alike. The host holds the real worktree and project folder, where the agent runs. This computer holds an empty stand-in for each at `<shell folder>/.kangentic/worktrees/<n>`, which the board uses for the task's identity.

An MCP tool answers from the layer the fact belongs to:

- **Where the agent works is the host's value.** A worktree or project path, a session `cwd`, a git or process fact, and a port the agent's server listens on are returned as the host sees them, never as the stand-in.
- **This computer is local, and labeled.** The Browser pane, a forwarded local port, the app's logs and Kangentic's own process metrics are returned as they are, with `location: 'local'`.
- **Each path, URL, pid or port in a tool's `data` carries `location: 'host' | 'local'`.** A local project reports `'local'` and nothing else about its answers changes.
- **A path the agent passes in is a host path.** An attachment or a file to drop is fetched from the host, or refused with a sentence. It is never read from this disk.
- **A copy is labeled as one.** A transcript, events file or session file the relay brought here holds the host's content, possibly stale, and its local path is not openable by the agent. The tool returns the host path of the original beside it.

The rule is [mcp-tool-host-values](../../.claude/rules/mcp-tool-host-values.md), and `remote/host-paths.ts` is the one map between the two names for a folder. `callHandler` sends a tool's `message` and drops its `data`, so the host's value is in the message, not only in `data`. A local project's messages are unchanged.

A session's folder is on both machines and holds different files on each. The host has the settings and hook folders while the session runs. `events.jsonl` is built on this computer from what the host relays, so it has no original there. `kangentic_get_session_files` asks the host which files exist, and answers `exists: null` when it cannot ask, which never means absent.

## What runs where

Bytes cross through `remote/host-transfer.ts`: `sh` scripts over `runCommand`, one base64 chunk at a time, because the helper's file jobs decode text and a new helper method has no handler on a daemon a relay rejoins with no version check. The scripts hold a path beneath the host's home themselves and refuse a symlink, because `runCommand` does not check its arguments. A write also refuses a path with a `.` or `..` in it, because `mkdir -p` walks a `..` that follows a folder it just made. So a file in `/tmp` on the host cannot be attached, and the agent is told to copy it into its working folder.

- **An opening prompt names the host.** `{{worktreePath}}`, `{{projectPath}}` and `{{attachments}}` resolve to the host's paths for every prompt and automation (`resolveTaskTemplateVars`), and a handoff's history file names the original rather than this computer's mirror of it.
- **Attachments are copied to the host before the agent starts,** to the path the prompt names, and on a column move whose message names them. A file already there at the same size is left. One that cannot be copied is named where the prompt lists them, and the agent starts anyway. The copy runs under the task's lock, so all of it has two minutes, and what is left then is named the same way. A file attached while an agent runs reaches the host at its next start or such a move.
- **An attachment an agent names is fetched from the host,** and a file of the same path on this computer is never read. One that cannot be fetched is named in the tool's message. One call holds at most 200 MB from a host. `kangentic_browser_drop_files` fetches each file the same way before it drops anything, under a name made safe for this computer, and removes a drop's folder on a later drop a day on, because a page may read the file long after the drop.
- **A Browser capture saved to a file is copied to the host,** into the agent's working folder. The pane is on this computer, so the capture is made here. A copy that fails fails the save.
- **`run_script` runs on the host,** in the task's worktree, through `sh`, with the same `KANGENTIC_*` variables. Its output is discarded, because a reply is one frame. A variable past 32 KiB is left out and named in the run's detail, because Linux refuses one past 128 KiB and a request is one frame too. A superseded move stops waiting for the script, but nothing can reach a running command on a host, so it goes on to its own timeout there.
- **`webhook` and `notify` run on this computer.** `localhost` in a webhook's URL is this computer, not the host.
- **A workflow's own agent runs on the host,** in the project's folder, through the same launch as a task's agent. It reads another project only on the same host, by its path there. A request for a project on another machine grants nothing and says so.
- **Dev ports are checked on both ends.** A reserved port is free on the host and on this computer, because the server binds it there and its forward binds it here. A host that cannot say reserves nothing.

## Worktrees on a host

A task in a remote project works in its own git worktree on the host, as a local task does, so two agents never edit the same files. The host's git makes it, through one `sh` script the helper runs (`remote-worktrees.ts`). Nothing about it uses this computer's git.

- **Where.** `<project folder on the host>/.kangentic/worktrees/<n>`, on a branch named from the task's title. This computer keeps an empty stand-in folder at the same path under the project's shell folder, and the task row records that path. The roots map turns it into the host's path when the agent starts, and a check that the folder exists finds it, so nothing that handles a task's folder needs to know it is remote. The stand-in is deleted with the worktree.
- **What it does, in order.** It checks the folder is the top of a plain repository (not a subfolder, not itself a linked worktree) with a commit, fetches the base branch (best effort, never asking for a password), picks the start point (`origin/<base>` when the fetch landed it, else the local branch, else the remote one), clears a husk at the path, and runs `git worktree add`. A branch the task already has is attached, not recreated. The base is the task's own, else the project's default, else `main`, else `master`, else the host's current branch. A base the task names that the host does not have is an error with that sentence. If the task lets go of the spawn while git runs and the script has already made the worktree, the worktree is removed before the spawn stops, since no task row names it yet.
- **Skipped, with the reason a local task gives.** `not-a-repo`, `nested-worktree`, `no-commits`, and `disabled`. The task then works in the shared folder.
- **The Branch row asks the host first.** The New Task and edit forms probe the project's folder to enable or disable the Worktree option. For a remote project that probe is the host's git (`git/remote-git-probe.ts`, through the same resolver as the reads below): the folder is the top of a repository, is not a linked worktree, has a commit, and which branch it is on. A repository with no commit yet reads "No commits yet", not "Not a git repository". A host that cannot answer rejects, and the form leaves the option alone instead of reading the empty stand-in as "not a repository".
- **Removal.** Done, delete and a project's removal run `git worktree remove --force` and `git worktree prune` on the host, and delete the stand-in. The branch is kept, as for a local task. The path must be exactly one folder below `.kangentic/worktrees/`, checked before the script runs, because the script deletes it. A host that cannot be reached leaves the worktree and the task's path in place, and the task retries later.
- **The Done drop asks the host first.** The pending-changes check counts the worktree's uncommitted files with the host's git, so the confirm dialog names them before the forced removal. A host that cannot answer is read as "there are changes", never as clean. That includes git's own status failing on the host, and a folder that is not the top of its own worktree, which git would otherwise read as part of the repository around it.
- **Not done on a host.** The Post-Worktree Script (it is shell text for this computer, so it never runs here), the files copied from the project root, the node_modules link, the sparse checkout that leaves out `.claude/commands/`, and spare worktrees. An agent installs its own dependencies in the worktree.
- **Still local-only.** PR linking and the branch switcher read git on this computer, where the stand-in is an empty folder, so they find no repository for a remote task. A worktree the user deletes on the host leaves the task pointing at a folder the agent cannot start in.

## Git reads on a host

The Changes panel, the branch header, blame, file history and the commit graph for a task on a host read the host's git, not the empty stand-in here. A git call in a folder that sits under a remote project's shell folder goes to the host, and any other folder goes to this computer's git as before. Each entry point asks one resolver first (`git/remote-git.ts`, registered in `remote-hosting.ts`, built in `remote/host-git.ts`): `gitAt`, `openSimpleGit`, `runGitWithTimeout` and `readGitObject` for git, and `DiffService` and `DiffWatcher` for the working tree. A new git call site needs no change to work for a host.

- **One read is one `sh` script** that the helper runs with `runCommand`. Git's arguments are arguments of the script, never shell text. It sets `GIT_OPTIONAL_LOCKS=0` and `GIT_TERMINAL_PROMPT=0`, so a read never takes the index lock the agent's own git needs and never prompts. No environment of this computer is sent.
- **A reply is one frame, and a frame's JSON body is 256 KiB,** so the script writes its output to a file under `~/.kangentic/tmp/` and returns the first 96 KiB as base64 with the size. A second script pulls the rest in 144 KiB pieces and removes the file with the last one. A diff, a blame or a file of any size comes back byte for byte, binary included, and a piece that is short or an id that is gone is an error, never a partial answer. More than 64 MiB is refused. The host sweeps files left by a link that never came back after two hours.
- **An answer that did not come is never an empty one.** A down link, a timeout, a host that cannot start `sh` all reject with `RemoteGitUnavailableError`. The branch header then keeps what it showed, instead of drawing "Detached HEAD" and no commits ahead, and a file's content rejects instead of showing an empty file.
- **The working tree is read on the host too.** The line counts of untracked files, the working-tree side of a file and a changed image come from the host (`HostGit.countUntracked`, `readWorkingFile`, `readObject`). A path that is absolute, climbs out of the folder, is a symlink or runs through a symlinked folder that leads out reads as missing, so a read never leaves the repository. An image reads at the same size cap as a local one.
- **A simple-git method other than `raw`, `revparse`, `show` and `diff` is refused for a host** with "is not available for a project on a host yet", so a caller that would have run git in the stand-in fails with a sentence. The branch switcher and Update from base are among them.
- **Live updates are polled.** The host's disk cannot be watched from here, so `DiffWatcher` asks the host every 2 seconds for a fingerprint: HEAD, git's status, and the modified time (to the nanosecond) and size of every changed or untracked file, in one request, taking no lock. A second edit to a file that was already modified moves it, which git's status alone would not. The first answer is the baseline, polls never overlap, and the answer after an outage always refreshes the panel, because a change made meanwhile is unknown. Measured on a repository of 5,684 tracked files with a 46,885-file `node_modules`: 3 to 7 ms of the host's time per poll. A watcher in the helper (Node's `fs.watch` with the `ignore` option, which took 361 inotify watches against 6,206 unfiltered) would make an update instant and is not built.

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

All 15 adapters that declare `supportsWslCli` declare `remoteCliName` and run on a host. **None has been started by the app with its real CLI.** Each is covered by unit tests against a fake host. The one exception to "real" is transcripts: real Kimi Code, Goose, OpenCode, Codex, Gemini, Aider and Droid conversations have crossed the real helper and relay in Docker (see [Transcripts](#transcripts)), run from a test, not through a spawn, and an export has crossed a real `ssh` with the connection killed partway (`scripts/ssh-link-rig.mjs`, which CI runs). The mock CLIs of the first 14 have run on a real sshd in a Docker container through the real app (Kimi Code joined after that run, so it has only the unit tests). That run added the host over ssh with a password, made a remote project, and started tasks for 14 agents (eight at once in one host folder). It confirmed, for the agents that start there:

- the agent runs on the host under the host program's own Node, and its trust, settings and MCP files are written there with hook paths of the host;
- a file the user already had (`.gemini/settings.json`, `.cursor/mcp.json`, `~/.gemini/trustedFolders.json`) keeps its own entries beside Kangentic's;
- a project file Kangentic creates is added to the host's `.git/info/exclude`, and one the user had is not;
- moving the tasks away puts every file back as the user had it, removes the files that were not theirs, and removes the session folders;
- a hook fired on the host reaches this computer's event log, in order.

### Which agents a remote project has

A remote project's pickers (Settings > Agent, the Column Manager, New Task) list what the host has installed, never this computer's PATH. `agents.list` reads the project's remote and asks the host `<cli> --version` through its login shell for each agent that declares a CLI name there (`host-agent-probe.ts`). Each agent comes back with one of three answers:

- **Found,** with the host's version. The CLI path field shows the CLI's name there and is read-only, because a spawn on a host runs the host's own CLI and ignores a path typed here.
- **Not found,** only when the host's shell says so (the program cannot start, or exit 127).
- **Not checked,** when the host could not be asked (the link is down, the program timed out, it refused `--version`), with the reason under the field. A failed ask is never read as an absence, and such a list is not kept, so the next open asks again.

Capabilities come from running the CLI, so a host's agents carry none. The model row stays for an agent the host has, or could not be asked about, as a field to type a model into with no list to offer (`useAgentCapabilityResolution`), in Settings, the Column Manager and the task forms. An agent the host lacks has no row. A whole answer is kept per host until the link reconnects or Re-detect is pressed. A spawn asks the same question first and refuses an agent the host lacks with "Claude Code (claude) was not found on Build server. Install it there, or choose another agent for this project." A host that cannot be asked does not block the spawn.

Real CLIs are the Beta gate: the mocks do not run hooks themselves, ask for a login, or draw a real TUI, and the real Codex hook-trust read and Cursor's `create-chat` have only met fakes.

### Transcripts

The conversation viewer, the search index and the token and cost ledger read a conversation's transcript from this computer's disk. For a session on a host, Kangentic keeps a copy of the transcript there. The adapter names the file (`remoteTranscriptFiles()`, as the path its own readers build under this computer's mirror of the host's home, `<config folder>/remote-homes/<host>/`, or under the project's shell folder), the helper tails the host's file by byte offset (`helper/file-tail.ts`, a poll every 250 ms), and the relay writes each chunk at the same offset into the copy (`RemoteSessionRelay.deliverChunk`). A reader that opens the transcript file (the conversation viewer, the search index) then finds a remote conversation where it finds a local one, and a path the CLI reports under the host's home (the status line's `transcript_path`) maps into the copy too, except for a file found by a search, whose copy has a name of its own. The live telemetry on the card (cost, context) is not from this: it comes from the status line the hooks carry, as it did before. The reader that follows the transcript for model and token figures while a session runs (`SessionHistoryReader`) stays off for a remote session, because a resumed session's backfill would read as fresh usage.

An adapter says how its transcript reaches this computer in one of three ways, and the relay asks again whenever the session's id arrives or an index grows (`RemoteSessionRelay.setAgentSessionId`). A file named late joins what is tailed, and what was already tailing keeps its place.

| Agent | What is copied | Declared by |
|---|---|---|
| Claude Code | The one file it appends to under `~/.claude/projects/<slug>/`, filed under the slug of the folder on the host | `remoteTranscriptFiles()` |
| Cursor CLI | The one file it appends to under `~/.cursor/projects/<slug>/agent-transcripts/<id>/`, filed under the slug of the folder on the host | `remoteTranscriptFiles()` |
| Qwen Code | The one file it appends to under `~/.qwen/projects/<slug>/chats/`, filed under the slug of the folder on the host | `remoteTranscriptFiles()` |
| Grok Build | `chat_history.jsonl` (viewer, index, archive) and `updates.jsonl` (token ledger) under `~/.grok/sessions/<cwd key>/<id>/`, keyed by the folder on the host | `remoteTranscriptFiles()` |
| Antigravity CLI | `~/.gemini/antigravity-cli/brain/<id>/.system_generated/logs/transcript.jsonl`, named once the conversation's id is known | `remoteTranscriptFiles()` |
| Kimi Code | `~/.kimi-code/session_index.jsonl` from the session's start, then the wire it names, `<session folder>/agents/main/wire.jsonl` | `remoteTranscriptIndex()`, `remoteTranscriptFiles()` |
| Goose | `goose session export --name <name> --format json` | `remoteTranscriptSnapshot()` |
| OpenCode | `opencode export <id> --pure`, or `session export <id> --standalone` on OpenCode 2 | `remoteTranscriptSnapshot()` |
| Codex | `~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<id>.jsonl`, found by a search of the whole tree | `remoteTranscriptFiles()`, a search |
| Gemini | `~/.gemini/tmp/<slug>/chats/session-<time>-<first 8 of id>.jsonl`, found by a search of every project folder | `remoteTranscriptFiles()`, a search |
| Copilot | `<session folder>/copilot-config/session-state/<id>/events.jsonl`, under the project on the host | `remoteTranscriptFiles()`, a path under a root |
| Aider | `<working folder>/.aider.chat.history.<id>.md` | `remoteTranscriptFiles()`, a path under a root |
| Droid | `~/.factory/sessions/<slug>/<id>.jsonl`, filed under the slug of the folder on the host | `remoteTranscriptFiles()` |

Ollama and Warp have no transcript file Kangentic reads, so nothing is copied for them.

**A search.** Codex and Gemini put a timestamp in the file's name that the session's id does not give, so the adapter declares a search (`RemoteTranscriptSearch`): a folder, how deep to look, a regular expression for the name, and where the copy goes. `watchFiles` carries it in its own `searches` field, the helper walks the folder newest name first, and it holds the file once found.

- **The host never says what it found.** The copy goes to the path the adapter registered, and the host sends bytes under a key, as for any tail. So a copy's name is not the host's: `rollout-copy-<id>.jsonl` in one folder for Codex, `session-copy-<first 8 of id>.jsonl` in the folder the readers build from the working folder for Gemini. The adapter's readers match both.
- **The search runs on the host because only the host can answer.** Codex's date folder is the day the session began, in the host's own clock, and a resume keeps it, so today's and yesterday's folders are not enough. Gemini's folder is a slug from its `projects.json`, with a number after a clash, and a host's worktrees are all numbers, so `7` in one project is `7-1` in the next.
- **A walk runs on a backoff, 1 second doubling to 15.** It reads a folder per day of history, so it does not run on the tail's 250 ms poll. Codex writes a new session's file at its first persist, not at the start, so the search can run for a while. The last pass at release looks once more.
- **An id from a hook comes from the host,** and it would become a file name on this computer. The session manager refuses an id that is no plain name where every id enters (`onAgentSessionId`), below the run evidence, so a dropped id still counts the launch as run. An adapter declares nothing for such an id as well. On Windows a backslash in a host file name is replaced when the path is built here, so a name from a host cannot climb out of the folder it is joined onto.

**A file in a session or working folder.** Copilot's config home is the session's own folder and Aider writes in the working folder, so neither file is in the mirror of the host's home. The relay takes a path under a root too (`rootPathToHost`), which maps a path under the shell folder to the same place on the host. The copy lands at that path here, in the session's record or the worktree's stand-in, where the adapter's readers already look. A copy in a stand-in goes with the stand-in when the worktree is removed, as an Aider history in a local worktree does.

**A Copilot resume.** Each spawn gets a new config home, and Copilot opens an empty conversation under the same id when that home holds no `session-state/<id>`. The copy of the folder has to happen on the host, where Copilot reads it, so `remoteResumeSeed` names the earlier record's folder and the relay copies it there before the agent starts, with one `sh` script, every value an argument. The local copy says which record held the conversation. A copy that fails is logged and the resume starts empty.

**An index.** A fresh Kimi session prints its id only as it exits, which can land after the session is released, and never lands after a force kill. So the index is tailed from the start and `watchFiles` answers its size then, and a new line past that size in the session's own folder names the id. Two sessions waiting in one folder cannot tell their lines apart, so neither takes one and each keeps the exit hint. A wrong id would resume another conversation, so an id from the index is provisional (`notifyInferredAgentSessionId`): it starts the copy but closes no capture channel, and the agent's own report still lands and replaces it when the two differ.

**An export.** Goose and OpenCode keep every conversation in one SQLite database in WAL mode, which an offset tail would corrupt. The CLI's own export runs instead, and three things shape how:

- **It goes to a file on the host, never through a reply.** A reply is one frame, capped at 256 KiB, and an export can be 100 MB. One `sh` script exports to a temporary file under `~/.kangentic/transcripts/<agent>/` and swaps it in, and the tail sends that file. Every value is an argument. The folder and files are owner-only, as a CLI's own store is, and the file is removed when the session is released.
- **Only a change is sent.** The script compares the export with the last one (`cmp`) and swaps it in only when it differs, so an idle session costs one CLI run and no link traffic. A swapped file has a new inode, which the tail already treats as starting over.
- **The pace follows the size.** The first export runs 5 seconds after the id is known, then at most every 30 seconds, and no sooner than the last export's size at 200 KB a second, so sending the whole file again never holds the link. An export is cheap: 100 MB took about a second. The last export runs at release, before the tail's last pass, and the readers of an ending session (the ledger, the finished index pass) wait for it, for at most 30 seconds.

An export is one document, so half of one is no conversation at all. It collects beside the copy as `<copy>.part` and is renamed over the copy only once whole (`FileChunkEvent.size`). The last whole copy stays until then, so a stale copy never reads as an empty one, and a rename a reader blocks on Windows is tried again. Main takes the export, and the retrieval worker only reads the file, because the worker has no route to a host. Totals are always of the whole file, never a difference: a replaced file has nothing to add to.

- **Subagent transcripts are not carried.**
- **A resume copies the whole file first.** The copy starts from byte 0 each session, at a few chunks a scan (about 1 MB a second) so it shares the link with the terminal instead of crowding it. A transcript of tens of megabytes takes under a minute to arrive, and the viewer fills in as it does. The last pass when a session is released is not paced, so the end of the conversation is in the copy when the session is.
- **The copy never proves anything gone.** It is empty until the first bytes arrive and stale while the link is down, so no reader may treat a missing or old copy as "the conversation does not exist". A resume still asks the host (`resume-conversation-guard.ts` answers `unknown` for a host, and nothing is demoted for want of a file). The Earlier conversations list keeps a host's row for the same reason: its transcript is never looked for, because an empty mirror once read as a conversation gone and deleted the row.
- **A file the agent replaces or shortens is copied again from the start.** The copy is emptied first. That covers a file that got shorter between two sessions too: a session's first chunk empties a copy longer than the host's file, since nothing else would remove the bytes past its end.
- **An offset tail is only right for a file that is appended to.** A rewrite in place on the same inode, at the same size or larger, would corrupt the copy, and the tail cannot see one. `tests/unit/remote-transcript-real-cli.test.ts` holds Codex, Gemini, Aider and Droid to it across one resume, byte for byte. Copilot's log is held to it by its docs alone. Gemini's `$rewindTo` and `$patch` are lines of their own at v0.66.0, its one rewrite swaps the file through a rename, and its legacy `.json` is never matched.
- **A conversation that forks is followed.** Claude's `/clear` starts a new conversation id in a new file. The new id reaches the relay as any id does, and the new file replaces the old one. The copy of the old conversation stays as it was.
- **Clear data deletes the copy.** Remove keeps it, so a host added back finds its transcripts where they were.

An agent that cannot run on a host fails the spawn with a sentence saying so.

## Known limits

- **The release path for the host program has not run yet.** A development build uses `npm run build:host`. An installed build reads `resources/host/manifest.json` and downloads the one archive its host's CPU needs from the release into `<config folder>/host-assets/<version>/` the first time it is needed, checks it against the manifest's SHA-256 and size, and only then sends it, so the installer grows by a few hundred bytes instead of about 90 MB. The release workflow's `build-host` job builds both archives, attaches them to the draft release and hands the manifest to every packaging leg, and each leg fails if its packaged `resources/host/manifest.json` is missing or for another version (`docs/releases/deployment.md`, "The host program"). The archives are byte-stable, so a re-run produces the same checksums. None of that has run in a real release yet: the first tagged build is its test, and the download is reachable only once the release is published. Until a build carries the manifest, a connect ends with "This build of Kangentic does not include the program to install on a host", shown on the host's row.
- **A host with `KillUserProcesses=yes` ends the daemon with the login session that started it.** Phase 0 measured this (`docs/audits/ssh-remote-phase-0-audit.md`): only linger plus `systemd-run --user` keeps it. Kangentic does not detect the setting or change the host, so on such a host the agents end when the session that installed the program ends, and recovery treats them as lost. Enabling linger is the host owner's call.
- **`ssh` starts on the pty host's terminal thread** when a link dials or redials, which on Windows holds local terminals for one `CreateProcess`.
- **Only reserved ports are forwarded.** A server an agent starts on a port it did not reserve with `kangentic_reserve_dev_ports` is not reachable from this computer. A panel that lists the host's ports and forwards them on a click is not built.
- **A crash of the process holding the links can leave a forward's `ssh` running,** holding its local port. The next forward of that port then shows as blocked, with the port named as in use on this computer. End the stray `ssh`, or restart the computer.
- **A host whose `sshd` sets `AllowTcpForwarding no` cannot forward.** The port shows as blocked with `ssh`'s own refusal.
- **A remote project's folder must be inside the user's home on the host.** The helper reads and writes only beneath the home, so a folder such as `/srv/app` is refused when it is added, with the home it must be in. Link or move the project under the home to use it.
- **A remote project whose folder is not a git repository shares one folder.** Every task works in it, so two agents edit the same files. The Add project form says so.
- **A remote project's `kangentic.json` is not read from the host.** The board config is read from the shell folder here, so a file committed on the host never reaches the app, and a change made here stays here. That covers everything the file declares, the Stop script included.
- **A custom branch is not checked out for a task with no worktree.** The checkout tests for commits with this computer's git, which finds no repository in the shell folder, and skips. A task with a worktree gets its branch on the host as usual.
- **A remote session has no process-tree watching.** The background-shell watcher and the session-id filesystem pass read this computer's disk, so they are off for a remote session.
- **Live model and token readers stay off for a host.** See [Transcripts](#transcripts). The ledger of a session on a host reads the copy. Cursor's `create-chat` writes nothing until the first turn, so the copy is empty until then.
- **An older program on a host copies nothing for Codex or Gemini.** Such a program ignores a search, so the copy is not made and the log says so once. Its plain files go on. Stopping the program on the host, which ends its agents, starts the current one.
- **A legacy Gemini `.json` session is not copied.** Gemini rewrites that form whole in place, which an offset tail would corrupt. A resume migrates it to `.jsonl`, and the search finds that.
- **A `GEMINI_CLI_HOME` set on the host is not followed.** The search looks under `~/.gemini`. The same holds for `$CODEX_HOME` and `COPILOT_HOME`.
- **An Aider session with no id is not copied.** A Command Terminal keeps Aider's shared default history, which no one conversation owns.
- **A Droid that ignores `--settings` has no id on a host,** so nothing is copied and a resume starts fresh. The hook and the copy were measured with `droid exec` 1.5.0. A signed-in TUI on a host has not run.
- **Copilot on a host is unmeasured.** The layout and the event log are from a Copilot on this computer, and no real Copilot has run on a host, because it needs a GitHub sign-in there.
- **A quit takes no last export.** A quit is one `suspendAll` frame, so a Goose or OpenCode copy stops at the export before it until that conversation next runs. A session ended any other way takes its last export.
- **A large export can end short.** The tail's last pass stops near 9.6 MB, so an export still arriving when its session is released keeps the last whole copy. The next session of that conversation exports again.
- **An export that takes over 12 seconds is stopped.** The last whole copy stays and the next tick tries again. An export of 100 MB took about a second on the machine measured, so this is a host under heavy load or a slower disk.
- **A conversation exported on a host does not page.** Goose and OpenCode on a host show the newest 16 MB in the viewer behind a notice, with no way to read further back, and the search index holds the same tail of a Goose conversation. OpenCode's index covers the whole export.
- **A second Kimi in one folder gets its id only at exit.** A force kill of such a session leaves it with no id, so nothing is copied for it. Two tasks in worktrees have separate folders and are not affected.
- **A Kimi the user starts by hand in a session's folder can be taken for that session, until it exits.** Between the spawn and the session's first message, a hand-run Kimi there writes the only new line in the index, and the viewer shows that conversation. The id from the index is provisional, so the session's exit hint replaces it on a clean exit. A force kill prints no hint, and the wrong id stays.
- **An older program on a host copies no export and names no Kimi id.** The daemon outlives an update of the app, so a host can run a program older than the one the app would install, and a version already complete there is not sent again. Such a program sends no file size and answers no sizes. An export then never lands and says so in the log, and a Kimi keeps the exit hint. Stopping the program on the host, which ends its agents, starts the current one.
- **A `KIMI_CODE_HOME` set on the host is not followed.** The mirror assumes `~/.kimi-code`.
- **A Kimi index that is replaced stops the id search** for the sessions running then, since a line past the old size may be an old one. They keep the exit hint.
- **A remote Goose card shows no live tokens or model,** which a local one reads from the database every 3 seconds. The ledger fills from the export.
- **OpenCode's subagent usage is empty on a host.** Child sessions are not in a parent's export.
- **A macOS client is unmeasured** for how an agent exits, as it is for local sessions.
- **System32 `ssh.exe` on Windows can lose bytes mid-stream.** Every frame is checksummed and a framing error ends the connection and resumes from the last acknowledged offset, so the loss costs a reconnect, not data.

The rules that keep a remote session from being treated as a process on this machine are in `.claude/rules/ssh-remote.md`, and the measurements behind the design are in `docs/audits/ssh-remote-phase-0-audit.md` and `docs/audits/ssh-remote-phase-1-audit.md`.
