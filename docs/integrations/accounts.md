---
type: Reference
title: Agent accounts
description: How one agent runs on several logins, an ordered list of accounts per agent, the account folder whose history links back to the agent's own home, the adapter contract, usage per account, and the continuation at a usage limit.
tags: [accounts, agents, subscriptions, rate-limits, adapters]
sources:
  - resource: src/shared/agent-accounts.ts
  - resource: src/main/accounts/
  - resource: src/main/accounts/account-report.ts
  - resource: src/main/agent/adapters/claude/accounts.ts
  - resource: src/main/agent/adapters/codex/accounts.ts
  - resource: src/main/agent/adapters/codex/rate-limits.ts
  - resource: src/main/agent/adapters/gemini/accounts.ts
  - resource: src/main/agent/adapters/grok/accounts.ts
  - resource: src/main/db/repositories/agent-account-repository.ts
  - resource: src/main/ipc/handlers/accounts.ts
  - resource: src/renderer/components/settings/tabs/AccountsTab.tsx
  - resource: src/renderer/components/settings/accounts/
  - resource: src/renderer/stores/accounts-store.ts
  - resource: src/renderer/utils/account-cards.ts
---
# Agent accounts

A user with more than one subscription for an agent signs in to each once, in Settings > Accounts,
and Kangentic picks an account per session. Each agent has one ordered list. A new session starts on
the first account in it with room. A user with one account sees no change anywhere: the list holds
the login they already have, and a spawn sets no extra variable.

## The model

| Kind | What it is | What a spawn sets |
|---|---|---|
| `default` | The agent's own home (`~/.claude`), account #1. Kangentic never moves, renames or overwrites what is in it, and it cannot be removed. | Nothing. |
| `folder` | A folder of Kangentic's, `<configDir>/accounts/<agent>/<n>`, holding only that account's login. | The CLI's home variable (`CLAUDE_CONFIG_DIR`), or for Grok the variable naming its login file. |
| `key-file` | An API key in a file the user owns. Kangentic stores the path and the variable names, never a key. | The file's keys the agent reads. |

Accounts live in the global database, table `agent_accounts`: one row per account with its agent,
kind, folder or key file path, the email and plan the CLI reports, a status (`ok`, `signed-out`,
`no-subscription`, `not-found`, `link-failed`), its position, and its last usage windows. A session
records the account it ran on in `sessions.account_id`. The two settings are global, under
`agent.accounts`: `orderMode` (`automatic` or `manual`) and `autoSwitchAtLimit`.

## The account folder

A second login needs its own folder, because the CLI keeps one login per home. Everything else in
that folder points back at the agent's own home, so every conversation stays in one place whichever
account wrote it:

| Entry | How it is shared |
|---|---|
| Conversation folders (`projects`, `file-history`, `session-env`, `shell-snapshots`, `todos`, `plans`, `tasks`, `paste-cache`, `transcripts`) | A folder link: a junction on Windows, a directory symlink elsewhere. |
| Setup folders (`skills`, `agents`, `commands`, `plugins`, `rules`, `themes`, `workflows`, `output-styles`) | A folder link. |
| `history.jsonl` | A hard link, on the same drive only. |
| `settings.json`, `keybindings.json` | A copy, refreshed before each spawn, since the CLI saves them by replacing the file. |
| `CLAUDE.md` | One line importing the home's file. |
| `.claude.json` | Rebuilt from the home's file with the login, the install ids and the caches left out, and each folder's trust merged. |
| The login, `sessions/`, caches and logs | The account's own. Never shared. |

`provisionAccountFolder` (`account-folder.ts`) makes and refreshes it, before every spawn on that
account. The rules it holds:

- The agent's home is a parameter, never computed inside. Under test it refuses the real home.
- It never moves, renames or overwrites anything in the agent's home. Entries an account folder
  already holds merge into the home, and a name that exists in both is kept aside under
  `.kangentic-kept-<time>` rather than dropped.
- A conversation folder it cannot link sets the account `link-failed`, and the account takes no
  session until the link is made. A conversation never lands where Kangentic cannot read it.
- A `history.jsonl` it cannot hard link (another drive) leaves that account's prompt history its
  own, and the row says so.
- Removing an account deletes its row and nothing on disk.

Measured on Claude Code 2.1.319 with three real accounts: a second login in its own folder left the
first signed in, a session wrote its transcript through the link into the home, a conversation with
a signed thinking block started on one account resumed on another, two accounts writing at once left
both transcripts whole, and deleting an account folder removed no transcript.

A user who already runs Claude with `CLAUDE_CONFIG_DIR` keeps that folder as account #1, and
Kangentic's own writes follow it: trust, the diff-panel key and project relocation go to the
`.claude.json` inside that folder (`claudeJsonPath`, `claudeHomeDir` in `claude-json-lock.ts`).
They used to go to `~/.claude.json` whatever the variable said, a file that user's Claude never
read.

A CLI installed in a WSL distro keeps the one login it has. A Windows junction cannot point into a
distro, so its card says so and a spawn there sets no account.

## The adapter contract

An adapter declares `accounts` (`account-support.ts`), and the generic layer in `src/main/accounts/`
reads only that. Nothing outside `adapters/` branches on an agent's name. An adapter that declares
nothing gets no card.

- **Folder** (`FolderAccountSupport`): `accountEnv(accountFolder, defaultHome)` (the variables
  that put a run on the folder), `defaultHome()`, the login arguments, the shared entries,
  `identify(cliPath, home)`, and optionally `readIdleUsage`, `isUsageLimitFailure`,
  `accountDataSubfolder`, `loginIsInteractive`, `conversationsStayOnAccount`, `unproven` (built
  with no second account to run it on, so its sign-in and session failures are reported) and
  `isConversationRefusal` (the provider's words for a conversation tied to another account).
  Claude Code declares it. Codex, Gemini CLI and Grok Build have one built and not enabled (see Per agent).
- **Key file** (`KeyFileAccountSupport`): the variable names a key file may set (a name ending
  in `*` is a prefix). Aider, Cursor, Droid and Warp declare it. Their own login is one per
  machine and stays account #1. Qwen Code has one built and not enabled.
  Optionally `envFileVar`, a variable naming a file the CLI loads after its own `.env` files. Aider
  loads `~/.env` and the project's `.env` over the environment, so a session on an Aider key-file
  account also sets `AIDER_ENV_FILE` to the key file, which Aider loads last.

`overridingCredentialEnvVars` names the variables a CLI uses ahead of any stored login. Kangentic
never removes one from a session's environment. When one is set where Kangentic started, the
agent's card shows one line naming it.

`usageWindows`, on either kind, names the usage windows the CLI always has, shortest first, as an
id, label, icon and duration. A CLI can leave a window out until an account opens it: Claude
reports its 5h window only once the account has run in it. Each row in the tab then draws a line
per declared window, and one the account has not opened reads Not started, so every row of an
agent is one height. Claude declares its 5h and 7d windows from `RATE_LIMIT_WINDOWS`
(`status-parser.ts`), the table its status line is parsed with.

## Which account a session runs on

Every spawn asks `resolveSpawnAccount` (`account-service.ts`) and merges the answer's variables over
the adapter's own (`buildSessionEnv`): the two task chokepoints, the Command Terminal and the
workflow agent. It runs after the adapter's `ensureTrust`, because the account folder takes its
trust entries from the home (`tests/unit/account-spawn-order.test.ts`).

Each candidate account is tried once, in order. One whose folder cannot be prepared is passed
over, and a refresh that throws does not stop the rest. When an agent has accounts and none can be
prepared, the spawn runs on the agent's own login and `spawn-account-unresolved` is reported. The
same holds for an account a continuation or a Switch to named: it is taken only while its status
is `ok`, and Switch to refuses an account that is not.

Automatic order sorts by the longest window each account reports, soonest reset first, so an
allowance is used before it resets. A drag or Switch to sets Manual, which keeps the saved order.
That holds for an agent that reports usage. One that reports none has no reset to sort by, so its
list is always the saved order (`followsOrderMode` in `account-service.ts`), and a drag or Switch
to on it leaves the order mode alone.
A drag only reorders, for new sessions. Switch to is a deliberate switch: the account goes to the top
and the agent's running task sessions restart in place on it, one at a time, each resuming its
conversation. One that was mid-turn is told to continue. Command Terminals and workflow agents
stay where they are. For an agent whose conversations stay on their account (Codex), Switch to
moves no running session, and its tip says so. The call answers once the sessions have moved,
and the renderer raises one toast from it (`describeAccountSwitchResult`): how many running
sessions moved, that new sessions start on the account when none was running, or that some
could not be moved and stay on their accounts.
An account that is signed out, has no plan, or has a window at 100% is skipped.

A resume follows the list like any other spawn. The shared folder is what lets any account resume
any conversation. The exception is an agent that declares `conversationsStayOnAccount`: both task
spawn chokepoints hand `resolveSpawnAccount` the account on the conversation's session record
(`conversationAccountOf`), and the resume runs there while that account is signed in.

## Usage

Each rate-limit window carries the account it was read for (`RateLimitWindow.accountId`). Main's
ledger and the renderer's snapshot key a window by account and id (`rateLimitWindowKey`), so two
accounts' weekly windows never overwrite each other, and a session's context bar draws its own
account's.

An account with no session running is read through the CLI (`readIdleUsage`). For Claude that is
`claude -p /usage --no-session-persistence --safe-mode`, then the account's own cached usage.
Measured: about 1.2 seconds, no model turn, no cost, and nothing added to the shared prompt history
or the conversations. Typing `/usage` into a hidden terminal added both, so that route was dropped.
`AccountUsageRefresher` reads one account at a time: when the app opens, when the tab opens, when a
window's reset passes, every 15 minutes, and before a switch. A failed read keeps the last values.
Nothing is read on a schedule for an agent with one account.

Codex reports its plan's windows in its own session files: each rollout `token_count` record
carries a `rate_limits` snapshot (`primary` and `secondary`, each `used_percent`,
`window_minutes` and `resets_at`, per `RateLimitSnapshot` in Codex's protocol). The Codex history
parser reads it (`adapters/codex/rate-limits.ts`), and usage from a history file is stamped with
the session's agent and account like usage from a status line. A session on an API key writes a
null snapshot, so it shows no windows.

## At a usage limit

With `autoSwitchAtLimit` on, a task's session that reaches its account's limit continues on the
next account (`account-continuation.ts`). The trigger is two facts together:

1. The turn failed, and the adapter reads the failure as a usage limit.
2. A read of that account, made then, shows it has no room.

A percentage alone never triggers it. The value moves while a turn runs, and a CLI reports a
momentary rate limit with the same error as a spent plan and retries those by itself. The next
account is read before it is chosen. The session then restarts in place on it, resuming the same
conversation with the prompt `Continue.`, and a toast names where it continues.

When every account is full, the session waits where it is, one toast names the first reset, and it
continues once a later read shows room. A Command Terminal or a workflow's own agent is not
continued: at its limit it waits as before.

## The tab

Settings > Accounts lays out its agents with the pure helpers in `utils/account-cards.ts`. An agent
gets a card of its own when it has two accounts, reports usage, has a variable that outranks its
accounts, or runs in WSL. Every other installed agent is one line on the More agents card, whose
one Add account opens a menu of those agents. The Account switching card holds Order and the
switch, and shows once an agent that reports usage has two accounts. Both settings act through
usage, so its description names those agents.

Rows carry no number. The list's order is the position, and the Active pill marks where new
sessions start. A row shows its drag grip only while the list is in the user's order: Manual, or an
agent that reports no usage, which Automatic cannot sort. Usage lines come from
`accountUsageLines` (`utils/rate-limit-window.ts`), one per declared window and then any other
window the CLI reported. A reset reads as a countdown (`41m`, `3h 14m`, `1d 4h`) and its tip gives
the moment. The percent beside the bar is what is used. The bar's tip says how much of the window
has passed, which is what the tick on the bar marks.

## Signing in

Add account runs the CLI's own sign-in (`claude auth login`) in a terminal of its own
(`account-login.ts`), pointed at a new account folder. It is a raw PTY in the pty host and not an
agent session, so it has no registry row, no hooks and no task tag. Kangentic reads nothing from
that screen. When the terminal ends, `identify` asks the CLI who signed in. An email already in the
list adds nothing and the dialog names the existing account. A sign-in that did not finish removes
the row it made, and so does one whose terminal could not start. The folder stays.

## Per agent

What ships is what was run on real accounts, or cannot touch a conversation:

| Agent | Accounts | Why |
|---|---|---|
| Claude Code | Enabled, a folder per account | Run with three real accounts: sign-in, shared history, resume across accounts, usage, switching |
| Aider, Cursor, Droid, Warp | Enabled, a key file per account | A key file only adds a variable to a session's env, so no conversation can move. None was run with a real second key. |
| Codex, Gemini CLI, Grok Build | Built, not enabled | Written from each CLI's source and docs. No second account was available to run them on. |
| Qwen Code | Built, not enabled | A key file per account, from the bundle's source. Nothing was run. |
| Kimi Code, Copilot, OpenCode, Goose, Antigravity, Ollama | Not built | See the end of this section. |

**Built, not enabled** means the declaration, its tests and its docs are in the tree
(`adapters/<agent>/accounts.ts`) and the adapter does not declare `accounts`, so the agent has no
card. Enabling one is two lines: `readonly accounts = <AGENT>_ACCOUNT_SUPPORT` on the adapter, and
the agent's name in `tests/unit/agent-accounts-enabled.test.ts`, which pins the enabled set over
the real registry. Each `accounts.ts` header names the run that has to pass first. The order they
are closest to ready: Grok (one real sign-in and a session on a current version), Qwen (one
session seen using a key file), Codex (two ChatGPT logins, `scripts/probe-agent-accounts.mjs`),
then Gemini, which has the most parts and the only failure modes that touch stored chats.

The rest of this section describes the four as built. Each adapter's `accounts.ts` header says
what was measured and what was not.

| Agent | An account is | Shared with the user's home | Sign-in | Usage | Not proven |
|---|---|---|---|---|---|
| Claude Code | A `CLAUDE_CONFIG_DIR` folder | Conversation and setup folders linked, prompt history hard linked, settings copied, state file derived | `claude auth login` | Live and idle | Nothing: measured with three accounts |
| Codex | A `CODEX_HOME` folder | `sessions`, `archived_sessions`, `generated_images`, `attachments` and `thread-writer-locks` linked; `history.jsonl` and `session_index.jsonl` hard linked; `config.toml` copied | `codex login` | Live only, from the rollout | A signed-in run, and a resume under another account |
| Gemini CLI | A `GEMINI_CLI_HOME` folder, data in its `.gemini` | `tmp` and `history` linked, the project registry copied, settings derived | Gemini's own screen | None | The sign-in screen, and a resume under another account |
| Grok Build | A login file, `GROK_AUTH_PATH` | Everything: `GROK_HOME` does not move | `grok login` | Idle, from Grok's billing answer | `grok login` writing the file, two accounts at once, and a resume under another account |

What each one adds to the shared shape:

- **Codex keeps its databases per account.** Codex finds a conversation by its id in the rollout
  file's name when its SQLite index has no row, so the index is not shared. Sharing it was
  measured to break: a shared row holds a path through the account folder, and with that folder
  gone the user's own home could not resume the conversation. An account spawn sets
  `CODEX_SQLITE_HOME` to its folder, and the `config.toml` copy drops a top-level `sqlite_home`.
- **A Codex conversation stays on its account** (`conversationsStayOnAccount`). Rollouts hold
  encrypted reasoning, and OpenAI's backend has refused a resume across logins. So a resume runs on
  the account its session record names while that account is signed in, even when the list has
  moved it or it is full, and Switch to leaves Codex's running sessions where they are. Codex also
  declares no `isUsageLimitFailure`, so it is never continued on another account at a limit.
- **Gemini's project registry is copied before every spawn** (`required`). With an empty registry
  a second home claimed the storage slot of a project folder that had no ownership marker, and the
  owner's chats were then filed under another project (measured). A copy that cannot be made
  blocks the account.
- **Gemini's settings are derived, and required.** `settings.json` holds the sign-in method, which
  is the account's own, beside `general.sessionRetention`, which decides when Gemini deletes old
  chats from the shared folder. The account gets every setting but the sign-in method. If the
  user's file cannot be read, the account is blocked instead of run on default retention.
- **Gemini account sessions share one trust file and keep their login in a file.** The account's
  env points `GEMINI_CLI_TRUSTED_FOLDERS_PATH` at the file Kangentic's trust step writes, and
  sets `GEMINI_FORCE_ENCRYPTED_FILE_STORAGE=false`: set to `true`, Gemini keeps the Google login in
  one keychain entry every home shares and deletes the folder's own file. On macOS the seatbelt
  sandbox's runtime folder (`<home>/.cache/.gemini`) is linked whole, since that sandbox keeps the
  chats there. A Gemini account is always a Google sign-in: an API key typed into Gemini's dialog
  goes to one keychain entry.
- **Gemini has no sign-in command** (`loginIsInteractive`). Add account starts Gemini itself in
  the account folder, the user signs in on its screen and exits, and the dialog says so.
- **Grok reads its plan usage with no session** (`readGrokIdleUsage`): `initialize`, then the
  `_x.ai/billing` request, over `grok agent --no-leader stdio`. Measured on 1.0.0: about half a
  second, no model turn, no session folder. The share used is `config.creditUsagePercent`, which
  xAI's backend leaves out at zero, so a missing value reads 0. With usage known, a Grok session
  whose turn fails with a limit and whose account then reads full continues on the next account,
  as Claude's does. Neither the percent on a used account nor a resume under another account has
  been seen, so both are best guesses and both are reported when they go wrong.
- **Grok moves only its login file.** Nothing is linked, so no conversation can land anywhere new.
  An account's sessions run standalone (`--no-leader`): a leader process is one per `GROK_HOME`
  and reloads that home's `auth.json`. Two things stay shared by the home: the models cache, which
  the account that wrote last decides, and a team's managed configuration, which would apply to
  every account's sessions.

Researched and not built as folder accounts:

- **Qwen Code** has key-file accounts built instead (not enabled). Its login is an API key under the variable its
  chosen provider names, and Qwen reads a variable from the process env before any `.env` or
  settings value, so a key file is the account. A `QWEN_HOME` folder was not built: it still reads
  the user's own `~/.qwen/.env`, Qwen removes a linked `file-history` folder daily on Windows and
  refuses one elsewhere, and Qwen names no signed-in user.
- **Kimi Code** has no accounts yet. Its `config.toml` mixes the login's own provider entries
  with the user's settings and has no JSON form to derive, its session index stores absolute
  paths, and its locks and local database have not been run through a folder link. No Kimi Code
  2.x was installed to measure, and its brief says not to ship it unmeasured.
- **Copilot, OpenCode 2, Droid, Goose, Antigravity** keep the login somewhere a folder cannot
  split: an OS keychain entry shared by every home, or the same database as the sessions.

## What is reported

Most of these declarations could not be run on a real second account, so a wrong guess first
shows on a user's machine. `account-report.ts` sends each of these to error reporting once per
run, tagged with the agent and the problem, and grouped as one issue per agent and problem:

| Problem | When |
|---|---|
| `folder-link-failed`, `folder-entry-user-owned`, `folder-entries-kept-aside` | An account folder's link or copy could not be made, or an entry there was not Kangentic's to replace. |
| `spawn-account-unresolved` | An agent had accounts and none could be prepared, so the spawn ran on the agent's own login. |
| `sign-in-not-recognized` | A sign-in's terminal ended by itself and no login read back. Unproven agents only. |
| `session-not-signed-in` | A session on an account read as signed in started signed out. Unproven agents only. |
| `turn-failed-after-move` | A turn failed within ten minutes of its session being moved to another account. |
| `conversation-refused` | A turn failed with the adapter's words for a conversation tied to another account (`isConversationRefusal`). |
| `usage-read-unreadable` | The CLI answered a usage read in a shape the adapter does not know. |

Only fixed facts are sent: the agent, the problem, an entry's name, a count. Never a folder path,
an email or a key. A provider's own error text is cut to a line with addresses, home folders and
long ids removed (`scrubFailureDetail`). An adapter marks itself `unproven` while its declaration
has not been run with real accounts: Codex, Gemini CLI and Grok Build do, so the two sign-in
reports are in place for the day each is enabled.

A session that starts signed out on an account also marks that account signed out, for every
agent, so the next spawn passes over it and its row offers Sign in.

## Limits

- Folder accounts are enabled for Claude Code only. Codex, Gemini CLI, Grok Build and Qwen Code
  are built and switched off until each is run with real accounts (see Per agent).
  `scripts/probe-agent-accounts.mjs` runs the proof for Claude and Codex once two logins exist.
- As built, Claude Code and Grok Build read usage with no session running and are continued on
  another account at a limit. Codex shows usage only while a session runs: a read with none would start
  its app-server, and each start that is stopped early leaves a plugin clone behind in the home's
  `.tmp`. Gemini has no usage read.
- `isUsageLimitFailure` for Claude reads the documented `rate_limit` error. A capture of a real
  spent plan has not been taken, so the read of the account's usage is what tells it from a
  momentary limit.
- Non-task sessions are not continued at a limit.
