---
type: Audit
title: SSH transcripts, agent CLI probe audit
description: "What real Kimi Code 2.5.1, Goose 1.57.0 and OpenCode 1.19.5 and 2.2.5 do on a Linux host (2026-11-05), run against a stub model: Kimi's session layout and an index line that appears on the first message, Goose's and OpenCode's own exports hold everything the readers need, and a 100 MB export takes about a second, so the link is the cost. Then what real Codex 0.167.0, Gemini 0.67.0, Aider 0.86.2 and Droid 1.5.0 do (2026-11-06): each file is appended to and keeps its inode across a resume, and which claims rest on source or on a run."
tags: [audit, ssh, remote, transcripts, kimi, goose, opencode, codex, gemini, aider, droid]
sources:
  - resource: src/main/agent/adapters/kimi/session-index.ts
  - resource: src/main/agent/adapters/kimi/kimi-home.ts
  - resource: src/main/agent/adapters/goose/session-store.ts
  - resource: src/main/agent/adapters/opencode/distro-sessions.ts
  - resource: src/main/remote/helper/file-tail.ts
  - resource: src/main/agent/adapters/codex/transcript-parser.ts
  - resource: src/main/agent/adapters/gemini/session-history-parser.ts
  - resource: src/main/agent/adapters/droid/command-builder.ts
---
# SSH transcripts, agent CLI probe audit (2026-11-05 and 2026-11-06)

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

`scripts/ssh-link-rig.mjs` covers the link. On Windows' own `ssh.exe`, against the built helper installed on a
fresh sshd, a 2.4 MB export (past a reply's 256 KiB cap) lost its connection after the first chunk arrived. It
ended whole, the reader's path held nothing until then, and the host's file was gone after the release. The
export there is a stand-in CLI. `ssh-rig.yml` runs the same pass on Linux.

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

## Codex, Gemini, Aider and Droid (2026-11-06)

The same rig on `node:24-bookworm`, with the stand-in taught OpenAI Responses (Codex) and Gemini's
`generateContent`. `remote-transcript-real-cli.test.ts` holds a real conversation and a resume in each CLI, and
all four pass, with the four cases above still passing beside them. Each run makes a real shell tool call. It
proves the path from a CLI's files to a reader, as above, not a spawn through the app or a real `ssh`.

**Read from source.** Gemini at v0.66.0 (`chatRecordingService.ts`): every write is `appendFileSync`, including
`$rewindTo` and `$patch`. The one rewrite, a resume of an unreadable file, renames the old file aside and swaps a
new one in, a new inode the tail already reads as starting over. So no snapshot mode and no detection of an
in-place rewrite were built. The folder is `getShortId` from `projects.json`: `slugify(basename)`, then `-1` on a
clash. Codex at rust-v0.163.0 (`rollout/src/recorder.rs`, `compression.rs`): a new session's file is created at its
first persist, a resume reopens the original path, and a rollout 7 days cold can become `.jsonl.zst`, with a resume
writing the plain file back first.

**Measured.** For all four, the test compares bytes, because a reader skips a line it cannot parse, so a text
assertion passes over a corrupted copy. After each session the copy equals the host's file byte for byte, and a
resume keeps the host file's inode and every earlier byte. That is one resume on a short conversation, and it says
nothing about a CLI's own later rewrite, such as a compaction or a title change in a TUI.

- **Codex 0.167.0.** `sessions/2026/11/06/rollout-2026-11-06T16-02-27-<id>.jsonl`. A resume grew the file from
  38,239 to 46,579 bytes. `codex features list` shows `local_thread_store_compression` as
  `under development`, off, so the `.jsonl.zst` path above did not run here. The committed 0.154.0 SessionStart
  capture does carry `transcript_path`. Kangentic does not depend on it, because a host's hooks may be untrusted.
- **Gemini 0.67.0.** `tmp/kangentic-real-cli-project-kc1r10/chats/session-2026-11-06T16-02-42039972.jsonl`, from a
  folder named `kangentic-real-cli-project-KC1R10`, so the slug is lowercased as the source says. No clash was run:
  the `7-1` case rests on the source and a unit test.
- **Aider 0.86.2.** The history grew across `--restore-chat-history`.
- **Droid 1.5.0, `droid exec` with a BYOK model.** The real SessionStart hook ran the transport script from a
  `--settings` file the relay had pushed, and its record reached this computer's inbox, which is the id the file is
  named by. `~/.factory/sessions/<slug>/<id>.jsonl` sits beside `<id>.settings.json` and `<id>.settings.json.bak`. A
  resume by `exec -s` extended it.

**Not run.** Copilot needs a GitHub sign-in on the host, so its copy rests on the layout measured locally and on
real event logs read through the real readers. Droid's TUI needs a Factory sign-in, so `--resume` in a TUI on a host
has not run. Neither CLI was started by the app.
