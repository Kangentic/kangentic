---
type: Audit
title: SSH remote agents, Phase 1 audit
description: "Phase 1 results for running agent CLIs on a Linux host over SSH (2026-11-03): the real link survived 20 of 20 killed ssh connections with the same PTY alive and a gap-free counter, askpass cannot supply a host-key fingerprint on Windows, and the helper bundle holds no Electron or better-sqlite3."
tags: [audit, ssh, remote, pty-host, link]
sources:
  - resource: src/main/remote/protocol/frame-codec.ts
  - resource: src/main/remote/protocol/resume-endpoint.ts
  - resource: src/main/remote/protocol/messages.ts
  - resource: src/main/remote/helper/helper-server.ts
  - resource: src/main/remote/helper/host-main.ts
  - resource: src/main/remote/link/remote-link.ts
  - resource: src/main/remote/link/ssh-connection.ts
  - resource: scripts/ssh-link-rig.mjs
  - resource: scripts/ssh-link-rig.client.ts
---
# SSH remote agents, Phase 1 audit (2026-11-03)

Phase 1 builds the wire between Kangentic and a host helper and proves it before any UI or adapter
work: a PTY runs in the helper, the connection can be killed, and the agent and its output survive.
Phase 0 measured the design (`ssh-remote-phase-0-audit.md`). This phase is product code, run first
against fakes and then against a real `ssh` and a real helper on a throwaway sshd container.

**Verdict.** The gate passed. The real `RemoteLink` and `PtyHostClient`, over System32 `ssh.exe`
9.5p2 into a real helper with real node-pty, were dropped 20 times in each of two runs (the `ssh`
tree killed by pid). Every one of the 40 rounds reconnected, the same PTY pid was still alive, the
owner epoch moved on by exactly one, and the counter in the PTY's scrollback ran without a gap.
From the kill to a connected link took 306 to 311 ms at the median and 360 ms at worst. No `ssh.exe`
or container was left behind. The same scenarios also pass in unit tests over in-memory pairs. What this does not prove is
listed at the end.

## What was built

| Layer | What it does |
| --- | --- |
| Frame codec | Every frame carries a magic number, a stream offset and two CRC-32s, and the header is checked before a body is awaited. A sequenced frame must continue where the last ended. |
| Resume endpoint | Outlives any one connection. Keeps sent frames until acknowledged, replays from the offset in the peer's hello, and answers what it cannot replay with a `reset` the peer reports as a gap. A new connection stays pending until the peer passes the owner's check, so a refused stranger never knocks the owner off. |
| Helper server | The unchanged `PtyHostCore` behind the endpoint. Maps the link's PTY ids onto the core's, refuses a second spawn for a task with a live PTY, and turns another installation away while it owns a connection or a running session. |
| Link | Implements the pty host's own `PtyHostTransport`, so `PtyHostClient` sits on it unchanged. A drop is a state, never an exit. After every attach it reads the helper's snapshot and reconciles exits, lost sessions and adoptable ones. |
| Host program | `node kangentic-host.js daemon` and `relay`: the daemon starts as its own session, binds a relative socket name behind an abstract-socket lock, and the relay starts it on demand. |
| `ssh` stream | An `ssh` child's stdio as one duplex stream, never detached, killed by pid with its tree, with `ssh`'s own stderr as the error. |

Not wired into the app: `RoutedPtyHost` stays out of `register-all` and `SessionManager` until Phase 2.
The existing host-lost path reports every PTY exited and recovery then respawns them, which beside a
live remote agent would start a second copy. `RemotePty.pid` is also a number a local pid site could
signal, so the pid type changes first.

## Pre-checks

Two claims in the signed-off design were checked on the rig before any code depended on them.

**The host-key question through askpass (Win32-OpenSSH 9.5p2, `SSH_ASKPASS_REQUIRE=force`).** `ssh`
does call askpass for the host-key question, direct and for each hop of a jump host, and answering
`yes` connects and records the key. But the program receives one argument holding only the first line
("The authenticity of host ... can't be established."), with no fingerprint and no
`SSH_ASKPASS_PROMPT`. An askpass cannot show the fingerprint, so the add-host flow learns it another
way: `ssh -o StrictHostKeyChecking=no -o PreferredAuthentications=none` into a temporary known_hosts
recorded the key in 44 ms direct and 245 ms through a jump, and the fingerprint matched the host's own.
A changed key never reaches askpass: `ssh` prints its full warning with the fingerprint and exits 255.
A jump hop asks its own question, so a jump host's trust stays with the user's SSH config.

**A key file by path.** A key created in Downloads with that folder's default permissions
(Administrators, SYSTEM and the user) was accepted by `ssh.exe` by path. Phase 0's refusal was the
scratch folder's wider inheritance. A downloaded key is mode 0644 on POSIX, which `ssh` refuses, so a
chosen key file is copied into Kangentic's folder with owner-only permissions on every platform. That
POSIX behavior is OpenSSH's documented one and was not measured here.

## Boundary

`tests/unit/remote-helper-boundary.test.ts` builds the helper's bundle with esbuild, dev and
production, and fails on `electron`, `better-sqlite3`, a main-only module or a dev tool in its graph.
The agent registry's 247 modules, which the helper needs for its output detectors, reach none of them.
`koffi` appears only in the Windows and macOS process readers, which load it with a dynamic import
inside a loader that never runs on Linux.

## Rig gate

`scripts/ssh-link-rig.mjs` stages the host bundle, node-pty's Linux prebuild and a pinned Node onto a
fresh rig container and runs `scripts/ssh-link-rig.client.ts`. The client spawns a shell that prints a
counter on the host, then 20 times kills its `ssh` and waits for the link to come back. The time is
measured from the kill to a connected link: it holds the link's own 100 ms redial delay, a new `ssh`
and sign-in, the relay joining the daemon, and the handshake. Two runs on the code as committed:

| Check, per drop | Run 1 | Run 2 |
| --- | --- | --- |
| Reconnected | 20 of 20, p50 306 ms, p95 347 ms, max 356 ms | 20 of 20, p50 311 ms, p95 348 ms, max 360 ms |
| Same PTY pid alive on the host | 20 of 20 | 20 of 20 |
| Owner epoch advanced by one | 20 of 20 | 20 of 20 |
| Scrollback counter without a gap, and progressing | 20 of 20 | 20 of 20 |

## What this does not prove

- **A silent drop.** Killing `ssh` closes the stream at once. A blackholed network leaves it open and
  silent, which only the heartbeat and the dead-peer timer detect. That is covered in unit tests with
  fake timers, not yet on the rig with `tc netem`.
- **Terminal traffic under the Windows byte loss.** Phase 0 saw System32 `ssh.exe` lose bytes in bulk
  transfers. The frames refuse a damaged stream, and a sweep test drops bytes at many positions, but
  a real terminal flood through `ssh.exe` with every frame's checksum checked is still to run.
- **Quit.** Nothing here writes the one `suspendAll` frame the plan sends at quit.
- **Install, lease renewal, the MCP relay and the transcript spool.** The host program is staged by
  hand on the rig. Each is Phase 2.
- **A real agent.** The PTY ran a shell loop. Claude Code's exit paths over this link are Phase 2's gate.
