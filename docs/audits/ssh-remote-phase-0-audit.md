---
type: Audit
title: SSH remote agents, Phase 0 audit
description: "Phase 0 measurements for running agent CLIs on a Linux host over SSH (2026-11-02): a helper daemon's PTYs survive every drop except KillUserProcesses=yes, a read mirror serves status in 60 ms but must never prove a file absent, and System32 ssh.exe lost bytes mid-stream so every frame carries a CRC, and ssh2 is out."
tags: [audit, ssh, remote, pty-host, mirror]
sources:
  - resource: src/main/pty/host/pty-host-core.ts
  - resource: src/main/pty/readers/status-file-reader.ts
  - resource: src/main/agent/shared/confirmed-missing.ts
  - resource: src/main/agent/adapters/claude/conversation-gone.ts
  - resource: src/main/agent/adapters/claude/transcript-locator.ts
  - resource: src/main/transition-engine/resume-conversation-guard.ts
  - resource: scripts/probe-ssh-daemon.mjs
  - resource: scripts/probe-ssh-daemon.entry.ts
  - resource: scripts/probe-ssh-mirror.mjs
  - resource: scripts/probe-ssh-mirror-host.mjs
  - resource: scripts/probe-ssh-mirror-paths.mjs
  - resource: scripts/probe-ssh-signin.mjs
  - resource: scripts/probe-ssh-flood.mjs
  - resource: scripts/probe-ssh-quit.mjs
---
# SSH remote agents, Phase 0 audit (2026-11-02)

The feature: a project whose repo and agent CLIs live on a Linux host, with this machine running only
the UI. A helper on the host owns the PTYs, and Kangentic reaches it over SSH. Phase 0 measures the
design before any product code exists, against throwaway sshd containers.

**Verdict.** All five spikes have reported, the quit and flood spikes only in part. `PtyHostCore` runs unchanged under plain Node
as a socket daemon, and its PTYs survive every way the connection can die on a default host. A local
read mirror of the CLI's session folders passes its latency and sync bars, and passes the
false-verdict bar only when the helper, never the mirror, proves a file absent. System `ssh` stays:
`ssh2` reads no ssh config and has no ProxyJump, certificate or FIDO support. Two results change the
design most. Windows `ssh.exe` 9.5p2 lost bytes mid-stream, so every frame needs a CRC and a framing
error must end the connection. And `BatchMode=yes` does not reach a jump hop, so a hop can prompt and
hang forever unless the app also sets an askpass environment.

| Spike | State |
| --- | --- |
| Helper daemon survival | Done, below |
| Read mirror against remote reads | Done, below |
| Sign-in matrix, `ssh` against `ssh2`, jump hops, multiplexing | Done, below |
| One stream under flood, with a byte-integrity check on every transport | Partial, below. Latency measured, integrity not cleared |
| Quit delivery through a separate link process | Partial, below. Some rows are small-n or not run |

What each partial spike did not reach is listed at the end under "Still open after Phase 0".

## Rig and method

Each probe starts its own container from `scripts/probe-ssh-rig/` (Ubuntu 24.04, glibc 2.39) with a
scratch key and a scratch `known_hosts`, shapes the link with `tc netem` (egress only, so a stated
50 ms is the round trip), and never reads the developer's ssh config. The client is the Windows
OpenSSH `ssh.exe` 9.5p2 that ships in System32, started by full path: a bare `ssh.exe` under Git
Bash finds Git's own MSYS build. Several spikes shared the machine and the Docker VM, so tail
numbers carry that noise. Anything not measured is marked, and a number from a stand-in says so.

## Helper daemon survival

Question: can `PtyHostCore` run as a plain Node socket daemon on Linux, and do its PTYs outlive every
way the connection can die?

Method. An esbuild bundle of the real `pty-host-core.ts` with a stub transcript sink, run by Node
24 linux-x64 (SHA-256 checked against the published list) with node-pty's linux-x64 prebuild. NDJSON
over a unix socket, with a fake renderer port carrying the real output path. The PTY runs a python3
counter that prints a sequence and a timestamp every 100 ms. Every run kills all the user's
processes first, so the daemon under test was started by the ssh session the run destroys. Each run
checks the same PTY pid, one daemon, a rebind to a fresh wire id, a snapshot, live output after it,
a typed line, a refused second spawn for the task, and the exit on the fresh id.

Bar: 20 of 20 PTYs alive, reattach within 3 s, no duplicate, no counter gap beyond the scrollback.

| Case | Result | Reattach p50 / max | Missing lines |
| --- | --- | --- | --- |
| ssh killed (10 `taskkill`, 10 `TerminateProcess`) | 20 of 20 | 215 / 1034 ms | 0 |
| Every sshd killed, session processes included | 20 of 20 | 440 / 2683 ms | 0 |
| Only the listener restarted | 20 of 20 | 216 / 301 ms | 0 |
| `systemctl restart ssh` (systemd rig) | 20 of 20 | 263 / 337 ms | 0 |
| netem loss 100% for 8 s, then restored | 20 of 20 | 834 / 1985 ms | 0 |
| Logout, four session kinds | 20 of 20 each | 248 / 289 to 1730 ms | 0 |

180 of 180 runs had one counter and one daemon in `ps`, a refused second spawn, a working rebound
input path, and the exit on the fresh id. The margin is thin on a loaded machine: the slowest
reattach was 2683 ms, and a single ssh connect took 1 to 2.6 s in 6 runs against the usual 200 ms.
The cause was not found. A listener restart and `systemctl restart ssh` left the old connection up
in 20 of 20, so neither is a drop. Only killing the session's own sshd is one. Under netem, ssh
noticed the drop in 3.1 to 5.1 s with `ServerAliveInterval=1` and `ServerAliveCountMax=3`.

### KillUserProcesses=yes

The helper dies when its birth session ends. Every death was a SIGTERM the daemon caught, 82 to 380 ms
after the session ended.

| Start | KillUserProcesses | Linger | Survived |
| --- | --- | --- | --- |
| plain, or `setsid` | no | either | 3 of 3 |
| `systemd-run --user`, scope or unit | no | no | 0 of 3, dies at about 10 s |
| `systemd-run --user`, scope or unit | no | yes | 3 of 3 |
| plain, or `setsid`, any session shape | yes | either | 0 of 3 |
| `systemd-run --user`, scope or unit | yes | no | 0 of 3, dies at about 10 s |
| `systemd-run --user`, scope or unit | yes | yes | 3 of 3 |

A second open session did not save it. `setsid` changes nothing in any cell, because the kill is by
cgroup, and linger alone changes nothing under `yes`. `systemd-run --user` without linger is worse
than plain `setsid` on a default host, since the user manager stops 10 s after the last session and
takes the helper with it.

Detection, run as the user over ssh: `loginctl show-session --property=KillUserProcesses` prints
`KillUserProcesses=yes`, and `loginctl show-user "$USER" --property=Linger` prints `Linger=no`. On a
host without systemd the first fails with `loginctl: command not found`, exit 127, and the risk is
absent. After a death, the next hello carries a record the dying daemon wrote (`reason`, `pid`,
`cgroup`), which is the raw error a user can be shown. A SIGKILL leaves no record. Whether the
counter outlived the daemon was not measured. `loginctl enable-linger` worked as the unprivileged
user with polkit running and failed with a masked polkit, but a real denying policy was not run.

### A flood behind an undetected drop

One run: a PTY writing about 1 MB/s under netem for 45 s. The daemon cannot see this drop, because
the old relay stays connected, so focus stays set and nothing acks. The PTY was paused 28 of 45 s
and the daemon's send queue reached 16 MB with no bound. A takeover ended it at once. A quiet PTY
never gets near this, so it costs a flooding agent, not an idle one.

### Also measured

- Bundle 304 KB with node-pty's 76 KB prebuild, staged 1.2 MB. The Node tarball is 32 MB and
  `bin/node` alone is 124 MB unpacked of 213 MB.
- Daemon RSS 74 MB idle, 79 MB with five sessions. Each relay is a 50 MB Node process for as long as
  the link is up.
- The agent registry loads under plain Node (15 adapters), and a real core resolved `claude`,
  spawned, and returned scrollback and an exit. No module failed. `koffi` is an external in the
  graph and never loaded on Linux.
- The reap stopped a real detached process carrying the task tag. It refuses a task id that is not a
  uuid, silently.
- An absolute unix socket path works through 108 bytes and fails at 109 with `EINVAL`. `chdir` into
  the folder and a relative name works at any length.
- Eight relays starting at once, 20 rounds, always one daemon, with a start lock the kernel frees at
  any death. Folder mode 700, socket 600.
- Not run: an `exit` during a drop, a host without `pam_systemd`, a real agent CLI.

### What the design changes

1. Start with plain `setsid`. Check `KillUserProcesses` first. If it is `yes`, start through
   `systemd-run --user` only when linger is already on, and otherwise show the two raw lines and do
   not start. Enabling linger changes the host and outlives the app, so it is the user's call. The
   manager property is the global switch, and `KillOnlyUsers` and `KillExcludeUsers` narrow it per
   user, which was not measured.
2. Never use `systemd-run --user` without linger.
3. The helper needs its own heartbeat and drop rule: no frame for N seconds clears focus, releases
   backpressure and closes the socket. Its send queue gets a bound.
4. A takeover compares connections, because the old socket's close can land after the new owner took
   over.
5. The daemon writes a last-exit record on every catchable death, and the hello carries it.
6. Bind with `chdir` and a relative socket name.
7. Ship `bin/node` alone.
8. Refusing a second spawn for a live task lives in the helper's entry, since the core has no such
   check.
9. The helper graph check pins that `koffi` stays lazy.

## Read mirror against remote reads

Question: should CLI session folders reach Kangentic through a local read mirror, or through remote
reads, and are the numbers acceptable?

Method. A host agent watches folders with inotify and streams appended bytes with offsets over framed
stdio through `ssh.exe`, and a local writer applies them under a scratch folder on NTFS. A
generator writes a realistic Claude layout: transcripts growing at the measured agent cadence, some
rewritten, and `status.json` rewritten at 4 Hz. The host tree is 5,000 files and 2.15 GB, with six
files of 100 MB. Clocks were aligned from minimum-RTT pings, and a clock-free check agreed within a
millisecond. Round trip 51.5 ms.

| Bar | Result |
| --- | --- |
| Status p95 within 500 ms, idle | Pass, 59.7 ms (p99 61.1) |
| Same, 8 busy sessions | Pass, 66.2 ms (p99 89.6) |
| Same, with a sync in flight | Pass, p95 62 to 115 ms by credit setting. Worst run left 3% of writes undelivered |
| Initial sync of 5,000 files, 2 GB, bar 10 min | Pass, 59.4 s plain and 23.7 s gzip level 1. Index-ready is a stand-in, a parse of every line |
| No false `expired` in 500 resumes, helper decides | Pass, 0 of 500, and 100 of 100 true positives |
| The same 500 with the mirror as proof | 279 false `expired`, the rate the rule prevents |

The wire is the bottleneck: of 57 ms total, 51 ms is the link. `StatusFileReader`'s 100 ms debounce
comes on top. A remote read per poll is out: `ssh <host> cat` took 660 ms p50 because it opens a
connection each time, against 52 ms on a held connection and 0.3 ms from the mirror. The reason for
a mirror is that `peekClaudeTranscriptFile` is synchronous on main, polled every 2 s, and the
retrieval worker has no link.

### Byte loss through System32 ssh.exe

19 of 24 full mirror syncs lost one contiguous run of 65 to 97 KB mid-stream, inside a payload. It
happened at the default rekey limit, before any rekey, so a rekey is not the trigger. It did not
change with split or single writes, credit size, or local disk writes. Git for Windows' `ssh.exe`
(OpenSSH 10.0p2) lost nothing in 3 runs and `docker exec` nothing in 3, which is too few to clear
anything. The same System32 `ssh.exe` lost nothing in 14 other runs, 16.5 GB of counters and `cat`
of the real tree. So the trigger is something in the mirror's traffic shape, and it is not
established that a terminal stream can or cannot hit it. A tracker search found no report of silent
stdout loss. A newer Win32-OpenSSH build was not run.

With a CRC on every frame the failure reads `bad crc`. Without one the frame straddling the loss
is applied corrupted, and on a terminal stream those bytes would reach xterm first. Recovery as
built (magic, stream offset, CRC, header checked before waiting on a payload, a framing error ends
the connection, reconnect with a manifest) handled 8 losses in about 18 GB, 0.4 to 1 s each, with
every tree equal by SHA-256 after. The worst dark window for status was 1.2 s, one sample, over the
500 ms bar, and rare.

### False verdicts

Real code (`assessResumeConversation`, `ClaudeStatusParser`, `proveClaudeConversationGone`, bundled
from `src/`) ran against real files, with injected mirror lag and a real ssh process killed for
link-down. The mirror as proof gave a false `expired` for a just-created conversation under lag (43
of 120), a renamed slug folder (46 of 120), a cold mirror (120 of 120) and link-down (70 of 70), and
14 of 60 false `never-started`. The helper gave `unknown` in all of those. The rate depends on the
injected lag, so 279 is not a field rate, but natural lag alone produced false `expired`. A gone
file must be proved on the host, and link-down means `unknown`.

Two sites in the code must be covered. `resume-conversation-guard.ts:203` calls `isConfirmedMissing`
on a raw reported path, and a Linux path on Windows stats `ENOENT`, so an unrouted path reads as
missing. Line 196 returns `expired` from a `cli_target` mismatch with no disk read, so
`isSameCliPlace` for an ssh place must compare the host id only. Both are read from code, not run.

### inotify and Windows paths

- Per-folder watches cost 47 ms and 20 MB for 15,000 folders. Node's recursive watch on Linux watches
  every file too: 406 ms and 72 MB for the same tree.
- A new folder followed at once by a write was missed 1,000 of 1,000 times without a listing after
  the watch, and 0 with one.
- Watch exhaustion makes `fs.watch` throw `ENOSPC` while existing watches keep firing, but a
  recursive watch reports nothing at all. A queue overflow lost 23,616 of 40,000 events with no
  error. A rescan of 5,000 files takes 104 ms, so a periodic rescan is required.
- A watch on `status.json` itself saw 3 of 20 atomic renames. A watch on its folder saw 20.
- On NTFS, `a:b` succeeds as a hidden stream, reserved names such as `aux` and `con.txt` are kept
  literally, `-home-dev-Repo` and `-home-dev-repo` are one folder, and a 396-character path works in
  Node but fails as a child's cwd. The mirror's stateless path mapping percent-encodes uppercase,
  non-ASCII, invalid characters and `%`, caps a segment at 240 with a persisted digest table, and
  refuses empty, dot-dot and absolute names. It was tested on 1,794 adversarial names with 0
  collisions, 0 failed writes and 9 of 9 traversal attempts refused (`probe-ssh-mirror-paths.mjs`).
  Only Node reads mirror paths in-process, never a child process and never as a cwd.

### What the design changes

1. A framing error ends the connection. Only a well-formed frame of an unknown type is dropped. Frames
   carry a magic number, a stream offset and a payload CRC, with the header checked first.
2. Hook records and terminal output replay from acked offsets out of a helper-side spool. A status
   snapshot is superseded by the next write, but a lost Stop or permission record is not, which can
   leave a card stuck active.
3. Mirror bulk runs on its own `ssh` connection. A desync means reconnecting the connection, so on a
   shared one every terminal on the host would drop for each bulk loss.
4. Bulk is credit limited (1 MB while a session runs, 4 MB otherwise) and gzip level 1 on non-images,
   which cut time 2.5 times and wire bytes 2.8 times for 1.6 times the host CPU. Status never queues
   behind bulk.
5. The mirror has a cold state: until the first sync ends, a reader treats it as empty of information.
6. Watches are per folder, with a listing after each new folder and a periodic rescan. Never recursive
   on Linux. On `ENOSPC`, fall back to the rescan.
7. A folder event for a vanished path deletes everything under it and closes its watches.
8. Each adapter declares its full-rewrite files (Gemini rewrites a whole session file per message) and
   its SQLite stores (OpenCode, Antigravity, Copilot, Cursor), which a mirror never copies.
9. Apply the host's mtime to each mirrored file, since `modifiedAt`, `scanProjectFolders` and Codex's
   capture read it. Read from code, not measured.

## Sign-in, jump hops and multiplexing

Question: can the app make sure no ssh hop prompts or opens a window, is the `ssh2` library a
replacement for system `ssh`, and can a running connection take more forwards?

Method. Windows OpenSSH 9.5p2 and `ssh2` 1.17.0 against a target and a jump host on a private Docker
network, with scratch keys and certificate authorities. Every config pins its own `known_hosts`,
`IdentitiesOnly` and no agent, so no ssh child read the developer's `~/.ssh`.

### BatchMode does not reach a jump hop

`-J` builds the hop's command from `-F` and `-W` only, so the hop gets none of the parent's `-o`
options, and a ProxyCommand child is the same. All 18 cells run with no treatment or with
`-o BatchMode=yes` hung until killed at 8 s, for an unknown hop host key and for a hop key that
needs a passphrase. With no hop, `BatchMode=yes` failed in 51 ms, so it works on the outer
connection and is lost at the hop.

| Treatment | Result |
| --- | --- |
| `SSH_ASKPASS` as a program that exits 1, with `SSH_ASKPASS_REQUIRE=force` | Fails in 176 to 396 ms on every transport, including a user's own ProxyCommand |
| An app-built `-o ProxyCommand=ssh -o BatchMode=yes -W %h:%p <jump>` in place of `-J` | Fails in 77 to 195 ms |
| A wrapper config that sets `BatchMode yes` and then includes the user's file | Fails in 74 to 214 ms for `-J` and ProxyJump, hangs for a user ProxyCommand, and depends on the included file's permissions |
| `BatchMode=yes` plus `ConnectTimeout=5` | Fails at 5 s. A floor, since the hop was already stuck |

The failure reads `Host key verification failed.` or `Permission denied (publickey).`, which is the raw
error to show. Resolving a chain with `ssh -G` for the app-built form was not run, and a user's real
config permissions for the wrapper were not tested.

### A stuck hop opened a window only when detached

A visible Windows Terminal tab appeared during this spike, and it was reproduced. It came from
`detached: true`, which starts the outer ssh with no console, so the hop's ssh creates one and the
default terminal shows it (the mechanism is inferred, the outcome is measured). From a windowless
Electron utility process with `windowsHide: true` and no `detached`, a hung hop opened 0 windows in 4
cases. A run without `windowsHide` opened none either, so the absence of `detached` is what matters.
Pass both. A hidden ConPTY parent was not tested, and the relay uses piped stdio.

### Timeout and tree kill

`ConnectTimeout` ends a stuck connect at its limit (5.04 to 5.07 s with `Connection timed out during
banner exchange`). After a natural timeout, or `taskkill /T /F` on the live root pid (480 to 583 ms),
0 processes were left in 5 shapes. A plain `child.kill()` left 2 in 4 of 4 hop shapes, the hop's ssh
and a `conhost`, and a later tree kill on the dead root did not find them.

### ssh2 is out

| Path | `ssh` 9.5p2 | `ssh2` 1.17.0 |
| --- | --- | --- |
| Host alias from an ssh config | Signs in | Fails. It reads no ssh config |
| ProxyJump | `-J`, config and ProxyCommand all sign in | No such option. The app would chain two clients by hand and resolve the chain itself |
| CA host keys | Signs in, and a wrong CA fails | Never offers a certificate host key algorithm |
| User certificates | Signs in | Rejects a certificate as a key |
| FIDO `sk-*` keys | Lists both types, no hardware to run | Parser supports rsa, dss, ecdsa and ed25519 only |
| Windows agent pipe | Signs in | Supported in source, run only against a stand-in pipe |

The real agent service was stopped and was not started, so that row is source review on the `ssh2`
side. To keep what `ssh` does, the app would have to reimplement an ssh config parser, `known_hosts`
handling with certificate authorities, ProxyCommand, certificate authentication and FIDO, which is a
whole client. System `ssh` stays.

### Multiplexing

`ControlMaster` does not work on Win32-OpenSSH: every form fails with `getsockname failed: Not a
socket`, and with no master `-O forward` cannot reach one. `~C` adds a forward to a running
connection only when ssh runs on a PTY with `EnableEscapeCommandline=yes` (22 ms), and a PTY would
corrupt a framed binary relay. The fallback is a separate `ssh -N -L` started on demand: spawn to
first byte p50 131 ms direct, 464 ms through a jump host and 612 ms at 50 ms RTT, with 0 failures in
60 runs.

### What the design changes

1. Every ssh start spawns with `windowsHide: true`, never `detached`, and piped stdin. It passes
   `-o BatchMode=yes`, `ConnectTimeout`, `ServerAliveInterval` and `ForwardAgent=no`, and sets
   `SSH_ASKPASS` to a program that exits 1 with `SSH_ASKPASS_REQUIRE=force`. The option alone leaves a
   hop free to prompt invisibly and forever. The shipped askpass program is still to be chosen.
2. The link keeps a tree kill keyed by the live root pid and a recorded list of child pids, never
   `child.kill()` alone.
3. `ssh2` is dropped, and the flood comparison no longer needs it as a candidate.
4. Reserved ports ride a separate `ssh -N -L` or the helper's framed tunnel. `ControlMaster` is not
   available.

## Quit delivery through a separate link process

Question: when the app quits, does one suspend-all frame reach the host through a separate Electron
utility process, given that Electron tears utility processes down at quit?

Method. A minimal Electron app on this repo's Electron (`scripts/probe-ssh-rig/quit-app/`). Main forks
a utility process as the link, the link spawns `ssh.exe` to a stand-in host that timestamps and acks
every frame, and on `before-quit` main posts the frame and runs a bounded drain on the link's pid. The
run is partial: the full sequence was stopped from outside after the undelivered cases, so a few rows
are small-n or not run, and each says so.

| Bar | Result |
| --- | --- |
| Delivery with the link up, bar 99.9% | Pass. 200 of 200 at each of 0, 50 and 200 ms RTT and 1,000 of 1,000 at 50 ms, 3,000 of 3,000 pooled. A run of 200 cannot show 99.9%, since its bound is 98.5% |
| Added quit time with nothing remote open, bar 5 ms | Pass. The handler costs 5.3 microseconds p50 and 63 microseconds at most, and no drain runs |
| Undelivered, then a reconnect suspends within 10 s | Pass, modelled. 200 of 200, 361 ms p50 and 1.35 s at most after the network was restored. The reconnect is a second launch against the stand-in, with no real lease or reconcile |
| A dead link's drain is bounded | Pass. The longest drain was 1.51 s and the longest whole quit 1.92 s, under the 6 s failsafe |

- The drain earns its place only when the link is busy. With an idle link, 600 of 600 frames arrived
  with no drain, so the failure was not reproduced there. With the link's loop held for 100 ms, 0 of
  200 arrived without the drain and 200 of 200 with it.
- `app.quit()`, a window close and `taskkill` without `/F` each ran `before-quit` and delivered 200 of
  200. A real SIGTERM on Windows is `TerminateProcess` and ran nothing, so a killed app looks like a
  dropped connection and the helper's own drop rule decides. A POSIX signal and a Windows session end
  were not run.
- With remote sessions open the drain adds about the round trip plus 158 ms (p50 160, 194 and 349 ms at
  0, 50 and 200 ms RTT), 100 ms of it settle ticks.
- Main saw the link's `exit` event 7 ms after a kill (n=6 and 8, not 200). A frame the link wrote just
  before exiting arrived in 6 of 6 runs of each variant, which is indicative only and no reason to
  shorten the ack wait.
- In blackholed quits the original frame arrived late in 177 of 200 runs, up to 333 s after a
  reconnect had already suspended the session.
- Not run: how long an orphaned `ssh` lives in a blackhole, and 200-run crash and flush cases. The
  netem here shapes only the host's replies, so the frame's own path to the host was never delayed.

### What the design changes

1. Keep the 1500 ms drain deadline and a 1300 ms link wait (the deadline less `HOST_EXIT_MARGIN_MS`). A
   link that gives up at 1300 ms settles near 1437 ms, and one that waited longer hit the deadline in 2
   of 200.
2. The link's pid joins `report.pids` and `killedCount` like `hostPid`. A quit with only remote
   sessions must count as a kill, or no drain runs.
3. `suspendAll` carries the owner epoch, so a late frame cannot suspend a session a reconnect has
   already taken over.

## One stream under a terminal flood

Question: can one SSH connection carry every terminal for a host, and what does it cost in echo
latency?

Method. A host program multiplexes logical sessions over framed stdio, each session either an echo or
a flood, with per-session flow control modelled on `backpressure-controller.ts`. A client on this
machine sends a keystroke frame every 100 ms for 60 s and records the echo latency. 82 runs of 60 s,
one run per cell, over System32 `ssh.exe` 9.5p2 and `ssh2`, at 50 ms RTT unless noted. The bars are
latency only.

| Bar, echo p99 | `ssh` | `ssh2` |
| --- | --- | --- |
| Idle, limit 100 ms | 53.6 ms, pass | 52.3 ms, pass |
| 4 floods at 20 Mbit/s, stock window (1 MiB per session, 256 KiB acks), limit 200 ms | 948 ms, fail | 937 ms, fail |
| 4 floods at 100 Mbit/s, stock window | 190 ms, pass by 10 ms | 187 ms, pass |
| 4 floods, 64 KiB window per session, 20 Mbit/s | 111 ms, pass | 109 ms, pass |
| 4 floods, 64 KiB window per session, 100 Mbit/s | 57 ms, pass | 58 ms, pass |

A 128 KiB window missed the bar at 20 Mbit/s (212 ms). The 64 KiB window costs nothing at 20 Mbit/s and
about 8.8 Mbit/s per session at 100 Mbit/s, 35 Mbit/s in total against 95.

- Reading ssh's stdio on a worker thread and posting each chunk to the framing thread made no
  consistent latency difference and cost 1.6 to 2.1 times the client CPU.
- `ssh2` tied on latency and used 24% of a core on the framing thread against 5% for `ssh`, so it
  does not beat system `ssh` here either. The plain client used 5% of a core at 4 floods and
  100 Mbit/s, plus 36% for `ssh.exe` itself.
- Not run: main at most 1% busy (an Electron harness starts, and was only smoke tested), the 1% loss
  runs, `ssh2` at 0 added RTT, repeats, and a second connection for bulk. The queue is the link's, so a
  second connection cannot remove it, and the 64 KiB window passes the bar on one connection. The case
  for a second connection is integrity only, which is the mirror spike's finding.

**Integrity is not cleared.** The runs saw 0 framing errors and 0 lost keystrokes in 81 runs, about
28 GB. Payload bytes were never compared, no CRC or sequence was verified, Git's `ssh.exe` was not run,
and this traffic differs from the mirror's loss case, so none of it clears the byte loss. Every pass
above is a latency pass.

### What the design changes

1. The ssh leg gets its own small credit window, 64 KiB per session, acked by the link process. The
   renderer's 1 MiB and 256 KiB window fails the bar at 20 Mbit/s.
2. Prefer one in-flight budget per connection to a rate cap per session. A cap is blind to the link and
   leaves 84% of a fast one idle.
3. Read ssh's stdio on the framing thread, with no worker hop.
4. Stay on system `ssh`.
5. Keep the magic, offset and CRC frames from the mirror spike. Terminal traffic is the case that still
   has to be run with payload comparison before Phase 1 trusts it.

## Still open after Phase 0

- Whether terminal traffic can hit the byte loss. The first Phase 1 test streams terminal output with a
  CRC and a sequence on every frame, over System32 `ssh.exe` and Git's `ssh.exe`, and compares payloads.
- A newer Win32-OpenSSH build, which the mirror spike could not run.
- Main's busy share under a flood, in the real Electron host.
- The real Windows agent pipe and a FIDO key, which need a machine with the service and the hardware.
- A real `exit` during a drop, a real denying polkit policy, and a POSIX signal or a Windows session
  end at quit.
