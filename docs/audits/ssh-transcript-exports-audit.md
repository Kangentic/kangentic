---
type: Audit
title: SSH transcripts, Kimi, Goose and OpenCode probe audit
description: "What real Kimi Code 2.5.1, Goose 1.57.0 and OpenCode 1.19.5 and 2.2.5 do on a Linux host (2026-11-05), run against a stub model: Kimi's session layout and an index line that appears on the first message, Goose's and OpenCode's own exports hold everything the readers need, and a 100 MB export takes about a second, so the link is the cost."
tags: [audit, ssh, remote, transcripts, kimi, goose, opencode]
sources:
  - resource: src/main/agent/adapters/kimi/session-index.ts
  - resource: src/main/agent/adapters/kimi/kimi-home.ts
  - resource: src/main/agent/adapters/goose/session-store.ts
  - resource: src/main/agent/adapters/opencode/distro-sessions.ts
  - resource: src/main/remote/helper/file-tail.ts
---
# SSH transcripts, Kimi, Goose and OpenCode probe audit (2026-11-05)

Claude Code's transcript on a host is one file a tail can copy. Kimi's file is named by an index, and
Goose and OpenCode keep every conversation in one shared SQLite database. All three adapters were built
from the vendors' docs with no real CLI behind them. This audit records what the real CLIs did, because
the design in `docs/platforms/ssh-remote.md` rests on it.

## Method

The `kangentic-ssh-rig` image (Ubuntu 24.04) with each CLI installed from its vendor's own channel, as
user `dev`. Each CLI was pointed at a local stand-in for an OpenAI-compatible model API, which answers
one shell tool call and then one line of text, so every run holds a real tool call and result at no
quota and with no account. Kimi ran in a real TUI under `tmux`. The captures trimmed of vendor prompt
text are `tests/fixtures/kimi-2.5.1-wire.jsonl`, `kimi-2.5.1-session-index.jsonl`,
`goose-1.57.0-session-export.json`, `opencode-1.19.5-export.json` and `opencode-2.2.5-export.json`.

## Kimi Code 2.5.1

- **The layout is what the code assumed.** The data root is `~/.kimi-code`. `session_index.jsonl` holds
  one `{sessionId, sessionDir, workDir}` line per session, and `sessionDir` is absolute:
  `~/.kimi-code/sessions/wd_<folder>_<hash>/session_<uuid>`. The wire is `agents/main/wire.jsonl` below
  it, at wire protocol 1.5. The older `~/.kimi` layout in some vendor docs is the retired Python CLI.
- **No session exists until the first message.** A fresh TUI writes no session folder and no index line,
  and says "No session yet". The first message writes both, within a second.
- **A fresh session never prints its id while it runs.** The welcome box's `Session:` line is blank. The id
  appears only in the exit hint (`To resume this session: kimi -r session_<uuid>`), and on a resume in the
  welcome box.
- **The index and the wire suit an offset tail.** A resume adds no index line. The wire keeps its inode and
  grows (111,782 to 115,088 bytes across one resume turn).
- **`kimi session list --cwd <dir> --json`** also lists `{id, workDir, sessionDir, createdAt, updatedAt}`.
  Kangentic does not use it: `createdAt` is the host's clock, and a new index line past a known size needs
  no clock and no CLI run.

## Goose 1.57.0

- **`goose session export -n <name> --format json` holds everything.** One JSON document with the session
  row's fields, including `usage`, `accumulated_usage`, `accumulated_cost`, `model_config` and
  `working_dir`, and `conversation`, an array of `{id, role, created, content, metadata}`. `content` is the
  same blocks as the database's `content_json`, and `metadata` the same as `metadata_json`, `userVisible`
  included. `created` is in seconds.
- **The database's columns match `session-store.ts`.** `model_config_json` has no `context_limit` when the
  provider declares none, which the reader already takes as unknown.
- **A name that is not there** exits 1 with `Error: No session found with name '<name>'`.
- **Stdout and `-o`** differ by one trailing newline.

## OpenCode 1.19.5 and 2.2.5

- **`export <id> --pure` on 1 and `session export <id> --standalone` on 2** print one JSON document,
  `{info, messages}`, on stdout. Version 1's "Exporting session" line goes to stderr. The session's id is
  `ses_<base62>`.
- **Version 1's messages** are `{info, parts}`, and `info.tokens` and `info.cost` sit on each assistant
  message. **Version 2's** are records of type `user`, `assistant` and `idle`.
- **An id that is not there** exits 1 on stderr, with nothing on stdout.
- **Child sessions are not in a parent's export,** so subagent usage cannot come from it.

## How long an export takes

| Export | Messages | Size | Time |
|---|---|---|---|
| Goose | 2,008 | 8.6 MB | 74 ms |
| Goose | 22,008 | 94 MB | 372 ms |
| OpenCode 1 | 2,003 | 10 MB | 560 ms |
| OpenCode 1 | 22,003 | 111 MB | 1,144 ms |

The long sessions are real rows repeated in a copy of the database. Three Goose exports of the long
session, beside a process inserting into that database, each took under 450 ms and printed valid JSON.
OpenCode's first 500 ms is its own start.

## End to end

`tests/unit/remote-transcript-real-cli.test.ts` runs in the rig (`scripts/probe-ssh-rig/transcript-clis.sh`,
whose header has the commands), on Node 24.22.2 in a `node:24-bookworm` container. Each real CLI holds a real
conversation, then the real helper, export script, tail and relay bring it to a mirror, and the adapter's own
readers read it there. All four pass: Kimi 2.5.1 with a fresh id found from the index, Goose 1.57.0 with a
resume replacing the copy with the longer conversation, and OpenCode 1.19.5 and 2.2.5 with an id arriving
after the start. No export file was left on the host.

It runs the helper in-process over an in-memory link, with the CLI started by the test. It proves the path from
a CLI's files to a reader, not a spawn through the app or a real `ssh`.

The first run of it found what fakes could not. A login shell on that image does not add `~/.local/bin`, so
`goose` was not found through the helper's shell, and the run's failure line was bash's own opening lines. The
first was the rig's: the real agent PTY starts through the same shell. The second was a fault, since those lines
can hold a pid and would defeat the log-once check, so a failed export now logs stderr's last line.

## Result

- Nothing needs a read of a CLI's private database on the host. Goose's and OpenCode's own exports carry
  every field the readers use.
- An export is cheap and the copy is not: 100 MB takes a second to write and over a minute to send at the
  tail's paced rate. So the schedule is paced by the last export's size, and an unchanged export sends
  nothing.
- A 12-second bound on an export sits inside the 15 seconds a request to the pty host gets, so no timeout
  needed raising.
- A fresh Kimi session has to find its id from the index, because the exit hint can land after the session
  is released, and never lands after a force kill.
