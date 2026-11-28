---
type: Reference
title: Agent accounts
description: How one agent runs on several logins, an ordered list of accounts per agent, the account folder whose history links back to the agent's own home, the adapter contract, usage per account, and the continuation at a usage limit.
tags: [accounts, agents, subscriptions, rate-limits, adapters]
sources:
  - resource: src/shared/agent-accounts.ts
  - resource: src/main/accounts/
  - resource: src/main/accounts/account-report.ts
  - resource: src/main/accounts/account-continuation.ts
  - resource: src/main/accounts/account-identity.ts
  - resource: src/main/accounts/account-login-watch.ts
  - resource: src/main/accounts/inherited-home-env.ts
  - resource: src/main/pty/spawn/account-home-env.ts
  - resource: src/main/shell-env.ts
  - resource: src/main/agent/adapters/claude/accounts.ts
  - resource: src/main/agent/adapters/claude/plan-carry.ts
  - resource: src/main/agent/adapters/claude/tool-results-written.ts
  - resource: src/main/agent/adapters/claude/auto-memory-folder.ts
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
kind, folder or key file path, the email, organization (`org_id`) and plan the CLI reports, a status
(`ok`, `signed-out`, `no-subscription`, `not-found`, `link-failed`, `replaced`), its position, and its
last usage windows. A session records the account whose home it started in, in `sessions.account_id`.
The two settings are global, under `agent.accounts`: `orderMode` (`automatic` or `manual`) and
`autoSwitchAtLimit`.

## The account folder

A second login needs its own folder, because the CLI keeps one login per home. Nearly everything
else in that folder points back at the agent's own home, so every conversation stays in one place
whichever account wrote it. Claude's `plans` is the exception: each account keeps its own, so a
plan file stays in the folder of the account that wrote it, until a resume on another home carries
a copy there (see below).

| Entry | How it is shared |
|---|---|
| Conversation folders (`projects`, `file-history`, `session-env`, `shell-snapshots`, `todos`, `tasks`, `paste-cache`, `transcripts`) | A folder link: a junction on Windows, a directory symlink elsewhere. |
| `plans` | The account's own folder. A resume carries the conversation's plan file into the home it runs on. |
| Auto memory (`projects/<project>/memory/`) | The home's own folder, by its real path. An account session's `--settings` sets `autoMemoryDirectory` to it, so its Writes do not go through the `projects` link. |
| Setup folders (`skills`, `agents`, `commands`, `plugins`, `rules`, `themes`, `workflows`, `output-styles`) | A folder link. One the home lacks is made empty there first. |
| `history.jsonl` | A hard link, on the same drive only. |
| `settings.json`, `keybindings.json` | A copy, refreshed before each spawn, since the CLI saves them by replacing the file. A change made on the account is replaced, and reported. |
| `CLAUDE.md` | One line importing the home's file. Text the account's own file held is moved aside first. |
| `.claude.json` | Rebuilt from the home's file with the login, the install ids and the caches left out, and each folder's trust merged. A server or approval changed on the account is replaced, and reported. A folder Kangentic made (a task worktree, a dev preview project) that the home no longer holds is dropped from the account too. Kangentic trusts such a folder in the home before any account spawns there, so its absence means its removal dropped it ([Claude Code](agents/claude-code.md#removed-worktree-entries)). Before this, every account kept its own copy of thousands of them, and a sweep of one file was refilled from the other. |
| The login, `sessions/`, caches and logs | The account's own. Never shared. |

`provisionAccountFolder` (`account-folder.ts`) makes and refreshes it, before every spawn on that
account. The rules it holds:

- The agent's home is a parameter, never computed inside. Under test it refuses the real home.
- It never moves, renames or overwrites anything in the agent's home. Entries an account folder
  already holds merge into the home, and a name that exists in both is kept aside under
  `.kangentic-kept-<time>` rather than dropped.
- A folder it links is made empty in the home when the home has none, a setup folder included.
  A folder an agent keeps beside its home (`~/.agents`, which Gemini reads) is made the same way.
- A conversation folder it cannot link sets the account `link-failed`, and the account takes no
  session until the link is made. A conversation never lands where Kangentic cannot read it.
- A link Kangentic made under another default home is made again to this one, never blocked. The
  link must point at the same entry in the CLI's built-in home (`~/.claude`), at the same entry
  of another account folder (`<configDir>/accounts/<agent>/<id>/projects` for `projects`, and
  nothing deeper), or at the same entry in the home the folder's links were last made to. That
  home is recorded as `linkedHome` in the folder's `.kangentic-home-record.json`, a local path
  that is never sent. Only the link is replaced, and what it pointed at stays where it is. A link
  anywhere else is the user's, and still blocks the account. This is Sentry DESKTOP-4S. Kangentic
  started once with an inherited `CLAUDE_CONFIG_DIR` and once without sees two default homes, and
  each run's links point at its own.
- A `history.jsonl` it cannot hard link (another drive) leaves that account's prompt history its
  own, and the row says so.
- Nothing made from an account session is copied back into the home. See the next section.
- Removing an account deletes its row and nothing on disk.

### What a session on an account writes

A link writes into the home, so a conversation, a skill or a plugin made from an account session
is everyone's. A copy and the rebuilt state file run one way, home to account, so a change made
there lasts until that account's next spawn. Kangentic does not copy it back: the home's files are
the user's, and a write into them from another account's session is not Kangentic's to make. What
it does instead is keep a person's text, and say when a change was replaced.

| A session on an account | Lands in | At that account's next spawn |
|---|---|---|
| Makes an agent, command, rule, output style, theme or workflow | The home, through the link | Stays. Before task #1118 a folder the home lacked was not linked, so it stayed in that account alone. |
| Edits user memory while the home has no `CLAUDE.md` | The account's own `CLAUDE.md` | Stays. Once the home has one, the account's file is moved aside as `CLAUDE.md.kangentic-kept-<time>` and the import line is written. |
| Changes a `/config` option kept in user settings, `/model`, the effort or the theme | The account's `settings.json` | Replaced by the home's, and reported. |
| Enables or disables a plugin at user scope (`enabledPlugins`) | The account's `settings.json` | Replaced, and reported. The plugin's files are in the linked `plugins` folder and stay. |
| Saves a permission rule to user settings | The account's `settings.json` | Replaced, and reported. |
| Runs `/statusline` | The setting in the account's `settings.json`. A longer command's script in `~/.claude`, the home. | The setting is replaced, and reported. The script stays. |
| Edits key bindings | The account's `keybindings.json` | Stays while the home has none. Replaced, and reported, once it does. |
| Runs `claude mcp add` at the default local scope | The folder's entry in the account's `.claude.json` | Replaced, and reported, when the home's file has that folder. Stays when only the account has it. |
| Runs `claude mcp add --scope user` | `mcpServers` in the account's `.claude.json` | Stays, on that account only. Replaced, and reported, when the home has a server of that name. |
| Sets a global config key (`autoConnectIde`, `diffTool`) | The account's `.claude.json` | Replaced, and reported, when the home's file has the key. |

Where each lands is from Claude's docs (Settings, MCP, Plugins, Status line) and from the home's
own `settings.json` on Claude Code 2.1.328, which holds the theme, the model, the effort and the
permission rules. The `/statusline` row is from the instructions 2.1.328 gives its setup agent:
update `settings.json` in the config folder the session runs on, and save a longer command as a
script under `~/.claude`. None of the rows was run on a second account.

A user-scope MCP server the home held and then removed goes from each account at its next spawn.
One removed before the first spawn after task #1118 stays, since nothing recorded that the home
ever held it.

**How a refresh tells whose change it is.** The account's file is no baseline. Claude rewrites
its state file between refreshes: measured on 2.1.328, one session changed eight shared top-level
keys by itself (`numStartups`, `tipsHistory`, `lastReleaseNotesSeen`, `githubRepoPaths` and
others) and each folder's `last*` fields. So each refresh records what the home held, as hashes,
in `.kangentic-home-record.json` in the account folder (`home-record.ts`):

- **The account's own**: a part the account holds differently from what the home held at the last
  refresh.
- **Replaced**: the account's own, and the refresh writes something else over it. Only this is
  reported, as `folder-change-replaced`, once the write has landed.

A copied file is one part, compared as parsed JSON, so a file the CLI wrote again in another
layout is unchanged. The state file's parts are what a user configures in it
(`claudeUserConfigParts`): each user-scope MCP server, each folder's local-scope servers and
approval lists (`allowedTools`, `enabledMcpjsonServers`, `disabledMcpjsonServers`,
`disabledMcpServers`), and the keys Claude's settings reference scopes to "Global config". That
last list is copied from the reference, so a key Claude adds later is not watched until it is
added here. The `kangentic` server is left out of `enabledMcpjsonServers`: Kangentic's own trust
step approves it in every folder it spawns in, so no user put it there.

Measured on copies of the dogfooding machine's files (a 1.4 MB home state file with 6,643
folders): the record is 1.2 KB and holds seven parts for the state file, a refresh after one
session's own writes reports nothing, a local-scope server added on the account is reported once,
and the three passes that find the parts add about 5 ms to a 40 to 60 ms refresh. Counting
Kangentic's own server, the record was 1.4 MB with 6,153 parts.

A copied or rebuilt file with nothing recorded is recorded and not judged, which is each of them
on the first refresh of a folder made before the record existed. `CLAUDE.md` is the exception:
nothing is recorded for it while the home has none, so with nothing recorded the home is taken to
have held nothing, and text that is not the import line is moved aside. A home file that is
missing, empty or unreadable is no answer: it removes nothing and leaves the record as it was. An
account's state file that is missing or empty holds no change to replace, so nothing is reported
for it. The record is written only when it changed, and never into the home.

Measured on Claude Code 2.1.319 with three real accounts: a second login in its own folder left the
first signed in, a session wrote its transcript through the link into the home, a conversation with
a signed thinking block started on one account resumed on another, two accounts writing at once left
both transcripts whole, and deleting an account folder removed no transcript.

A Write through a link is a different case. Claude checks the path it was asked to write and the
path it lands at. Measured on 2.1.322 with `scripts/probe-claude-plan-tool-approval.js --layouts`
(a sandboxed home and a local API stand-in, so no account is used):

| Write | Through a link into `~/.claude` | Through a link elsewhere | Into a real folder |
|---|---|---|---|
| The plan file, plan mode | Prompts: "Do you want to create ...md?" | Refused: "Cannot write ... while in plan mode." | Runs, no prompt |
| Auto memory, default and acceptEdits | Prompts: "a sensitive file" | Prompts | Runs, no prompt |

That is why v0.57.0's `plans` junction stopped every plan Write on a second account until someone
answered it. An allow rule cannot help: Claude's docs say allow rules "do not pre-approve
protected-path writes". `plansDirectory` cannot either, since Claude ignores a path outside the
project root. So:

- **`plans` is the account's own folder** (`own-dir`). Provisioning removes an old junction there
  as a link only, never what it points at, and makes an empty folder. The plans already in the
  home stay there. A link that names anything but the home's `plans` is the user's and stays,
  including one whose target is offline.
- **A resume carries the plan file** (`carryConversation`, `plan-carry.ts`). Claude names a plan
  file after the conversation's slug, which a resume keeps, and looks for it only in the home it
  runs on. Resumed on an account without the file, ExitPlanMode opened a bare "Exit plan mode?"
  with no plan. With the file copied in, it opened the plan as usual. On every resume the account
  service hands the conversation to the adapter, which reads the slug from the last message line
  of the transcript and copies the newest `plans/<slug>.md` and its subagents'
  `plans/<slug>-agent-<id>.md` from any home, keeping their modified time. Into an account folder a
  copy replaces an older one. Into the agent's own home it only adds a missing file. A failed copy
  is logged and never stops the spawn.
- **Auto memory stays shared.** An account session's `--settings` sets `autoMemoryDirectory` to
  the home's own memory folder for the project, by its real path, and that Write ran with no
  prompt (`auto-memory-folder.ts`). Claude names the folder after the main checkout, measured for
  a worktree, a folder inside a repository and a checkout whose git directory sits apart, and
  after the session's folder outside git. An `autoMemoryDirectory` the user or the project set is
  left alone. A linked worktree of a repository whose git directory sits apart gets none, since
  that layout was not measured, so its memory writes still prompt.

With every conversation folder linked (`--target tools`), a Write, Read and Edit in the project and
a Bash `echo` ran with no prompt, the transcript landed in the home through the `projects` link,
and a conversation resumed through it. A real session on a second account (task #1070's own, on
2.1.322) wrote its edit backups into `file-history`, its `session-env` folder and its Bash
snapshots into `shell-snapshots`, all through the links into the home, with no prompt. Nothing has
been seen writing into `todos`, `tasks` or `paste-cache` from an account (TodoWrite and TaskCreate
are off in a session against the stand-in), so those three are not measured. macOS and Linux were
not measured either. Claude's docs say the same two-path check applies to directory symlinks there.

A read out of `projects` is not covered by the real-path fix, and the one an agent makes is a
copy of a screenshot (task #1136). Claude saves every MCP image block it is handed under
`projects/<project>/<session>/tool-results/`, whatever its size, and names that file to the agent.
An agent that publishes the image copies it from there. Measured on 2.1.329 with
`--target tool-results`: the probe's tool returns a 1x1 PNG inline, then the stand-in runs a Bash
`cp` of it, with `Bash(cp:*)` allowed. The stand-in quotes each path and writes its backslashes as
forward slashes, the form Git Bash takes. An agent that passes a Windows path in another form was
not measured.

| `cp` from | `control` (no account) | `real` (account, real folder) | `protected-junction` (account) |
|---|---|---|---|
| The `tool-results` file Claude names | Prompts: "a sensitive file" | Prompts: "needs approval" | Prompts: "a sensitive file", naming the path in `~/.claude` |
| The tool's own copy inside the cwd | Runs, no prompt | Runs, no prompt | Runs, no prompt |

So the prompt is not an account's. With no account the file is in `~/.claude`, and with a real
folder it is outside the working directory. `projects` has to stay a link, since transcripts must
land in the home, and the fix is the second row. On a project on this computer, every Kangentic
screenshot tool also writes its image into a `copies/` folder in the caller's capture folder and
names it as `filePath`. The tool descriptions say to copy that, and the browser instructions add
`saveToFile` for a result that names none. A project on an SSH host gets no copy, and its
`saveToFile` still delivers there (see "A screenshot is also written to a copies folder" in
[browser-actions.md](mcp-server/browser-actions.md)).

A user who already runs Claude with `CLAUDE_CONFIG_DIR` keeps that folder as account #1, and
Kangentic's own writes follow it: trust, the diff-panel key and project relocation go to the
`.claude.json` inside that folder (`claudeJsonPath`, `claudeHomeDir` in `claude-json-lock.ts`).
They used to go to `~/.claude.json` whatever the variable said, a file that user's Claude never
read.

An inherited home variable that names one of Kangentic's own account folders is not the agent's
home. A session on a folder account runs with the CLI's home variable naming that folder, and its
terminal keeps it, so Kangentic started from that terminal (`npx kangentic`, `npm start`) inherited
it. Account #1 then read the folder account's login, and its Sign in, its sessions and every CLI run
with no env of its own went to that folder (Sentry DESKTOP-4R). So at boot, before anything starts a
child, `dropInheritedAccountHomes` (`inherited-home-env.ts`) removes each folder adapter's
`homeEnvVars` whose absolute value is inside `<configDir>/accounts/`, by real path or as written,
and logs the variable's name. Codex's `CODEX_HOME` is covered the same way. Only the instance's own
`configDir` is checked, so a `/preview` started from an account session's terminal, whose data
folder is elsewhere, keeps the variable as before.

The two shapes of an inherited home send different reports, so the reports say which one a user
hit. One that names an account folder sends `identity-changed` for account #1 and no folder
problem: each folder's `projects` link and that account's own link both resolve to the built-in
home. One that names any other folder (an XDG-style `~/.config/claude`) moves the default home
between launches. Each launch then finds the links the other made, which the relink rule above
now remakes, and sends `identity-changed` too when that home holds a listed login. This was read
from the code and run in temp-folder unit tests, not by relaunching a real account in WSL.

A shell's startup files can replace the variable a session's terminal was given. Measured on Ubuntu
24.04 in WSL2: a login shell started with `CLAUDE_CONFIG_DIR` set, and a `~/.bashrc`, `~/.zshrc` or
`config.fish` that exports another value, ran its command with the file's value in bash, zsh and
fish alike. An account session would then run in that folder, and a `/login` there could land a
folder account's login in another home. So the typed line sets each of the adapter's `homeEnvVars`
again after the clear (`buildEnvReassertPrelude` in `typed-launch.ts`): `export` for bash, zsh, sh,
dash and ksh, `set -gx` for fish, and nothing on Windows or for any other shell, none of which was
measured.

Account #1's sessions set no home variable, so an rc file that exports `CLAUDE_CONFIG_DIR` moves
them to its folder. Kangentic started from a desktop launcher used to read `~/.claude` all the
same, so their conversations landed where it did not look, and a launch from a terminal saw the
other home. So on macOS and Linux the login shell probe that restores `PATH` (`restoreShellEnv`)
also reads the folder adapters' `homeEnvVars`, and `adoptShellHomeVariables` sets one Kangentic
was not started with, unless it is relative or names a Kangentic account folder. The agent's own
home is then the folder its sessions use, however Kangentic was started. A value Kangentic was
started with still wins.

A CLI installed in a WSL distro keeps the one login it has. A Windows junction cannot point into a
distro, so its card says so and a spawn there sets no account.

## The adapter contract

An adapter declares `accounts` (`account-support.ts`), and the generic layer in `src/main/accounts/`
reads only that. Nothing outside `adapters/` branches on an agent's name. An adapter that declares
nothing gets no card.

- **Folder** (`FolderAccountSupport`): `accountEnv(accountFolder, defaultHome)` (the variables
  that put a run on the folder), `homeEnvVars` (those of them that name a place inside the folder,
  held to `accountEnv` by `inherited-home-env.test.ts`), `defaultHome()`, `loginArgs` (the arguments that run the CLI's own sign-in), the shared entries,
  `identify(cliPath, home)`, and optionally `builtinHome()` (the home with no variable set, whose
  links an account folder may hold), `readHomeIdentity` and `loginFiles` (the cheap reads
  that notice a replaced login), `loginEmailArgs`, `readIdleUsage`, `isUsageLimitFailure`,
  `carryConversation` (copies a resumed conversation's own files into the home it runs on),
  `accountDataSubfolder`, `loginIsInteractive`, `conversationsStayOnAccount`, `unproven` (built
  with no second account to run it on, so its sign-in and session failures are reported) and
  `isConversationRefusal` (the provider's words for a conversation tied to another account).
  Claude Code declares it. Codex, Gemini CLI and Grok Build have one built and not enabled (see Per agent).
  A shared entry says what a user configures in it when a replaced change should be reported:
  `reportReplaced` on a copied file, `userParts` on a derived one, whose `derive` is also told
  which parts the home dropped (`removedFromHome`). A `derive` that drops an account's parts by
  its own rule names them in `discardedParts`, and the refresh does not report them as replaced:
  no copy of the home's wrote over them. Claude's derive names a removed worktree's parts there.
  Claude's `settings.json`, `keybindings.json`
  and `.claude.json` do. The copies Codex and Gemini declare do not: nobody has watched those CLIs
  write them, and a file a CLI rewrites by itself would be reported at every spawn.
- **Key file** (`KeyFileAccountSupport`): the variable names a key file may set (a name ending
  in `*` is a prefix). Aider, Cursor, Droid and Warp declare it. Their own login is one per
  machine and stays account #1. Qwen Code has one built and not enabled.
  Optionally `envFileVar`, a variable naming a file the CLI loads after its own `.env` files. Aider
  loads `~/.env` and the project's `.env` over the environment, so a session on an Aider key-file
  account also sets `AIDER_ENV_FILE` to the key file, which Aider loads last.

`overridingCredentialEnvVars` names the variables a CLI uses ahead of any stored login. Kangentic
never removes one from a session's environment. When one is set where Kangentic started, the
agent's card shows one line naming it.

`usageWindows`, on either kind, names the usage windows the CLI's plans have, shortest first, as an
id, label, icon and duration. Each row in the tab draws a line per declared window the account has.
A window the account has but has not opened reads Not started: Claude reports a 5h window in its
status line only once the account has run in it. A window the account does not have at all draws
no line. Not every Claude plan has a 5h limit, and Claude's own cached usage says so with
`five_hour: null`, so the idle read names it absent (`IdleUsageReading.absentWindowIds`) and the
row keeps it in `absent_windows_json` (`AgentAccount.absentWindowIds`). Rows of one agent can then
differ in height. Only the idle read sets that list, since a status line that leaves a window out
says nothing about the plan. A live report of a window the list holds takes it off again, which is
a plan that gained the window. Claude declares its 5h and 7d windows from `RATE_LIMIT_WINDOWS`
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
allowance is used before it resets. When an account's longest window has reset since its last
reading, a shorter window does not stand in. For a Claude account, the 5h reset is hours away, but
a week that just rolled over resets in about 7 days. That account orders with the accounts that
have no reading until the next read. A drag or Switch to sets Manual, which keeps the saved order.
Saving the accounts settings (Order or the auto-switch switch) pushes `accounts:changed` from
`CONFIG_SET` (`accounts-config-changed.ts`), so the tab lists again once the write has landed. Lists overlap, because each one detects every
agent's CLI, so the store applies only the answer to its latest request.
That holds for an agent that reports usage. One that reports none has no reset to sort by, so its
list is always the saved order (`followsOrderMode` in `account-service.ts`), and a drag or Switch
to on it leaves the order mode alone.
A drag only reorders, for new sessions. Switch to is a deliberate switch: the account goes to the top
and the agent's running sessions move to it, task sessions, Command Terminals and workflow agents
alike, each at its first safe point (below). For an agent whose conversations stay on their account
(Codex), Switch to moves no running session, and its tip says so. The call answers once each
session has been looked at once, and the renderer raises one toast from it
(`describeAccountSwitchResult`): how many running sessions moved, how many working ones move at
their next pause, that new sessions start on the account when none was running, or that some could
not move. A task session that could not move stays on its account; a Command Terminal or workflow
agent whose start failed after its stop is ended or paused, with its conversation kept.
An account that is signed out or `replaced`, has no plan, or has a window at 100% is skipped. A
window at 100% stays there until its reset, whatever a later report says (see "Usage").

No spawn chooses from a reading that has run out, in either order mode. Manual skips a full
account, so the read below runs in both modes and an old reading is refreshed before it ranks.
Before a spawn that is not named to an account, for an agent with two or more accounts whose usage
can be read idle (`readIdleUsage`),
`resolveForSpawn` asks the refresher to read every `ok` account with no reading, a reading older
than a scheduled pass should leave (`USAGE_STALE_FOR_RANKING_MS`, 20 minutes), or a window whose
reset has passed since (`needsReadBeforeRanking`). The spawn waits up to 10 seconds for those
accounts' reads, never for reads of other accounts, then ranks on whatever is stored, and logs
when the wait ran out. An account is asked this way at most once a minute, so a read that keeps
failing costs one CLI run, not one per spawn, and a spawn that finds the read already queued or
running waits on it too. This also covers sessions spawned at boot, before the first scheduled
read. A ranking on an expired reading put the account last: an account with no live window sorts
after every account with one.

A resume follows the list like any other spawn. The shared folders, and the carry of what each home
keeps on its own (Claude's plan file, `carryConversation`), let any account resume any
conversation. The exception is an agent that declares `conversationsStayOnAccount`: both task
spawn chokepoints hand `resolveSpawnAccount` the account on the conversation's session record
(`conversationAccountOf`), and the resume runs there while that account is signed in.

### Running sessions follow the order

Under Automatic order, the agent's running sessions follow its top account with room (task #1200).
Automatic puts first the account whose week resets soonest, so its allowance is used before it
resets. Once that reset passes, another account leads, and a session left on the old one spends a
new week while the new leader's last days run out unused. On 2026-11-24 two task sessions did that
for 8 and 11 minutes, until they were paused, and an app that stays up for days had nothing else to
move them.

`AutomaticOrderFollower` (`account-order-follow.ts`) compares the agent's top account with room
(`topAccountWithRoom`, never the first row, so a full account is never the target) with the one it
last saw. It looks after each usage read and each pass of the refresher (`onReadSettled`), the pass
its reset timer starts 30 seconds after a window resets included, and after the accounts settings
are saved. It never looks on an `accounts:changed` push: a dogfood app sent about 2,000 of those in
one day. When the top changed, every running session of the agent on another account waits to move
there, and one toast says so (`accounts:following`). A reading that leaves the top where it was
moves nothing, so sessions do not flip back and forth: a resume on another account starts with a
cold prompt cache, one full prefill of the conversation charged to the new account, and the order
changes only at resets, a few times a week. The first look at an agent, at a launch or on a switch
back to Automatic, asks too; startup recovery already put its sessions on the top account, so that
is normally a no-op. Manual moves nothing. An agent that reports no usage, or whose conversations
stay on their account, moves nothing.

`SessionAccountMover` (`account-session-move.ts`) moves each waiting session at its first safe
point, one at a time, for the follower and Switch to alike. A newer target replaces the one a
session waited for, and a session found on its target, or on another row of the same login, no
longer waits. A session the usage-limit continuation holds is left to it. A safe point is:

- no tool call in flight and no permission prompt or question open (`automatedKeysBlocker`);
- no background shell or subagent of the session alive (`getOpenWork`, and the engine's subagent
  depth, which counts a background subagent from its start), since each dies with the restart. A
  shell the agent marked as a service is not one, as for the idle pause;
- nothing typed into its input box, which the restart would throw away (read again from the pty
  host just before the restart);
- and, mid-turn, the transcript holds the result of every tool call in the message whose call just
  ended (`transcriptToolResultsWritten`, read in the retrieval worker as
  `transcript.toolResultsWritten`).

The last point is measured. On Claude Code 2.1.331 a call's result is not in the transcript when its
PostToolUse hook fires: Claude appends a message's results when its next call starts, or 130 to
170 ms after the last one ends (15 of 15 tool ends, 128 ms to 2.4 s after the hook). Between two
parallel calls nothing open shows in the ledger while the first call's result is still unwritten. A
restart there would lose it. So after a tool end that leaves nothing open, the mover looks again at
150, 300, 600, 1,200 and 2,500 ms, and the next tool start cancels what is left. A restart in that
window cuts the reply the model is writing, which `Continue.` asks for again. An agent without the
capability, or one tracked from its PTY output alone, moves only when idle.

A session at its turn's end, or idle at its prompt, moves at once and resumes idle with nothing sent
to it. One caught between two tools resumes with `Continue.`. One that never reaches an in-turn safe
point moves at its turn end, which fires only once background work has drained. There is no forced
bound: a long-running background job holds the move until it ends. The safe point is asked again
under the task's lock, or just before the stop, and a session that left it waits for the next one.

Each kind restarts in place its own way: a task session through `restartTaskOn`
(`restartSessionForSettingsChange`), a workflow's agent through `restartWorkflowAgentOn`
(suspended, then started again on its conversation with the account named), and a Command Terminal
through `restartCommandTerminalOn`. The terminal's end is marked a respawn
(`Session.commandTerminalRespawn`): its window stays and adopts the slot's next terminal, and its
Browser pane stays. The leftover reaper waits while the slot's next start is in flight, then leaves
what the old agent left running alone when a terminal runs under its tag again, and reaps it, after
the background-session stop, when none does. The conversation is claimed in the same tick as the
end, so an Earlier resume cannot take it while the old agent exits. It starts again in the same
slot, with its tag, grid and name, on the account named, only once its old agent has exited, so two
agents never hold one conversation, and the slot stays reserved meanwhile. A move that gives up
after the end releases the slot and the claim, so the conversation is back in Earlier. A Stop
pressed on the window in that gap names the ended session, and the move then starts nothing.
Everything that can refuse is checked before the end: a terminal whose agent cannot resume a
conversation by id, or whose conversation has no history row, stays where it is, and one nobody has
used yet waits for its first turn, since its row is deleted when it ends. A window whose next
terminal never arrives closes after 60 seconds, as an end would. A workflow's agent with no
conversation id recorded yet waits too, since a restart would begin a new conversation.

A switch to Manual cancels the moves Automatic order asked for that still wait, and keeps the ones
Switch to asked for, since Switch to itself sets the order to Manual. A newer target that lands
while a session's restart runs moves the replacement session there too.

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
window's reset passes, every 15 minutes, before a switch, and before a spawn ranks an account
whose reading ran out. Nothing is read on a schedule for an agent with one account.

The read when the app opens waits for the launch to settle
([Crash recovery](../architecture/sessions/crash-recovery.md#when-a-launch-has-settled)), and
never runs sooner than 20 s after registration. It runs a CLI per account, and on the old fixed
20 s timer those runs landed while the resumed agents were still starting. A read a spawn asks for
(`readBeforeRanking`) and the tab's own read do not wait.

Building the cards (`AccountService.cards`) runs no account CLI. Every field of a card is a row in
`agent_accounts`, and the one thing it waits for is whether each agent's CLI is installed. The
tab's answer (`accounts:list`, `AccountService.listForTab`) does not wait for that, as below. The
build asks for all of them at once through `listCliPath`, which takes a remembered
detection ([Shells and paths](../platforms/shells-and-paths.md)) where nothing has started the
agent this launch, so drawing a card never starts a CLI nobody is using. Everything that runs a
CLI (a sign-in read, a usage read, a spawn) detects it through `resolveCliPath`, which always
probes.

The tab still waited for that check, though. After a restart the first two lists took 12.3 s and
the next two 4.3 s, while the startup detection ran, and Settings > Accounts drew nothing all that
time (task #1202). So the tab lists through `AccountService.listForTab`, and `accounts:list` answers
`{ cards, checked }`. Until a check has landed in this run, it answers at once from the agents the
last checked list held (`<configDir>/accounts-listed.json`, `listed-agents-file.ts`, each with its `unsupportedTarget`) and
their saved rows and usage, with `checked: false`. It writes no row and starts no CLI. It also starts
one check, and when that lands it saves the listed agents (only when they changed, and again on the next check when the write failed) and pushes
`accounts:changed`, so the tab lists again, checked. A saved agent with no rows, or whose adapter no
longer declares accounts, is left out. A check that fails is reported (`stage: tab_list_check`), and
the tab keeps the saved cards until its next open checks again. With nothing saved, which is the
first launch or the first after this file was added, the first answer is empty and unchecked.

A read that gives no windows keeps the last values and its read time, and is logged and reported
(`usage-read-empty`) with why: the run failed, the state file was missing or unreadable
(`state-unreadable`), it was not a record (`state-not-record`), it held no usage cache
(`no-cache`), the cache was older than 10 minutes, it held no window, or the adapter returned no
answer at all (`no-answer`). An empty list counts too, since storing it would wipe the windows and
still mark the reading fresh. The local log says it again only when the reason changes.

`no-cache` is also how a home looks before the CLI's first usage fetch there, as with an API-key
login or a Claude that has not shown its usage yet. So an account that never stored a reading
logs it and sends nothing. Once an account has had a reading, losing the cache is reported (Sentry
DESKTOP-4E: one install sent the earlier word `cache-missing`, now `no-cache`, on every launch). An account whose sign-in read says
it has no subscription (`no-subscription`) is not read for idle usage at all, because such a login
has no plan windows. A Claude cache whose
windows are all null is `no-windows`. A cache with some null windows is a reading, and names the
null ones absent (`absentWindowIds`): the plan does not have them (see "The adapter contract"). One whose `utilization` names none
of the windows the reader knows is `usage-read-unreadable` instead, with its keys, and so is one
with no `utilization` record at all, with the cache's keys. Either is a Claude Code release renaming
the fields, which would empty every Claude account's reading.

A failed run (`run-failed`) is reported from the second read in a row that fails for the same
account. One failed run during a network drop is not a defect. A flag the CLI does not know
(`--safe-mode` was measured on 2.1.319 only) fails every run, so it still reports, one read
later. A good read, or any read whose run worked, starts the count again. The adapter hands on
the error it caught and how the run ended (`EmptyUsageReadError`'s `cause` and `runFailure`, from
`execRunFailureOf`), and the report carries that as tags with the CLI's version, so a timeout,
an exit and a CLI that would not start no longer read the same.

A stale cache (`cache-stale`) is reported from the second read in a row that gives one, for the same
reason. The run exited 0 and its own usage fetch refreshed nothing. A network drop, a refused fetch
and a sign-in that needs renewing all look like that, and the read cannot tell them apart. Failed
runs and stale caches are counted apart, and any other answer between two starts the count again.
The report carries the CLI's version and `cache_age`, so a cache that never refreshes reads apart
from one that missed a pass.

Two calls to `accounts:refreshUsage` that overlap, as a tab that mounts twice sends, share one
in-flight batch of sign-in and usage reads instead of running each CLI twice.

**A full window holds until its reset** (`keepFullWindows`, `account-order.ts`). Both writers of a
row apply it: a live report (`recordUsage`) and an idle read (`refreshUsage`). A report that would
lower a stored 100 is dropped while that window's reset is ahead, unless the report names a later
reset, which is the next window. The two may round the reset apart by up to 10 minutes
(`SAME_WINDOW_SLACK_SECONDS`) and still be one window. A window with no reset time is never held.
Measured on Claude Code 2.1.330 (task #1147): with a weekly allowance spent, the status line of a
session on that account kept reporting 99, while Claude's own cache read 100. The continuation's
read stored 100 and moved the session. Another session still on the account wrote 99 over it
within 72 seconds, and the next column move spawned on the spent account again.

Claude's cache also says outright when a window is spent: `cachedUsageUtilization.limits[]` holds
entries with a `kind`, a `percent`, a `severity` and `is_active`. `readClaudeCachedUsage` reads an
active entry at `percent` 100 or more with no `scope` as a full window. An active entry under 100 was never
measured, so it leaves the window at its own percentage. Only `weekly_all` (the 7d window) is mapped, since it
is the only kind measured spent. A scoped entry (`weekly_scoped`, one model's allowance) leaves the
account usable for other models and is ignored.

Who is signed in is read by `refreshIdentity`, which sets an account's status. The tab reads every
account's sign-in when it opens. For an agent with two or more accounts, the startup pass reads
every account's sign-in, and each scheduled pass reads the sign-in of any account that is not `ok`
before its usage. `refreshUsage` skips an account that is signed out, so without those passes
nothing but the tab set one back. A sign-in read that gives no answer (a timeout, a CLI
mid-update, JSON with no `loggedIn`) throws `IdentityReadError` from the adapter: the account keeps
the status it had. An answer the adapter cannot read (`unreadable`) is reported as
`identity-read-failed` on the first read, since it means the CLI changed what it prints. A failed
run (`run-failed`) is reported from the second in a row for the account, as a usage read's failed
run is, because one timeout on a host out of memory is not a defect (Sentry DESKTOP-60). Two reads
of one account that run at once count as one: the tab reads outside the scheduler's queue, and
both fail at the same moment. The count is in memory and starts again at each launch.

An `ok` account's sign-in runs the CLI when the tab opens, on the startup pass for an agent with
two or more accounts, after a sign-in, and when its home's own files name another login. So a
failed `auth status` that runs once per launch is never reported. For Claude with two or more
accounts, a CLI that cannot run at all also fails the idle usage read on each scheduled pass, and
that read reports it. Codex has no idle usage read.

Only the CLI's own signed-out answer marks an account signed out. The one other writer of a
set-aside status is the reconcile in "A login replaced inside a session", which sets `replaced`.
Before this, a failed or unreadable sign-in read marked a working account signed out, its usage
was never read again, and Automatic put it last until the Accounts tab was opened. Any other
failure of a sign-in or usage read is a defect, reported through the `accounts` reporter (stage
`sign_in_read` or `usage_read`).

Codex reports its plan's windows in its own session files: each rollout `token_count` record
carries a `rate_limits` snapshot (`primary` and `secondary`, each `used_percent`,
`window_minutes` and `resets_at`, per `RateLimitSnapshot` in Codex's protocol). The Codex history
parser reads it (`adapters/codex/rate-limits.ts`), and usage from a history file is stamped with
the session's agent and account like usage from a status line. A session on an API key writes a
null snapshot, so it shows no windows.

## A login replaced inside a session

A home holds one login, so a `/login` in any session on it, or `claude auth login` in a terminal,
replaces the login of that home. No hook fires and the status line names no account, so Kangentic
notices it itself. Before task #1113 the next sign-in read rewrote the row's email: a `/login` in a
session on the agent's own home, to a login folder account 3 held, left the tab listing that login
twice and the login the home held before listed nowhere.

**One login is its email and organization.** `claude auth status` reports `email` and `orgId`, and
the home's state file records `oauthAccount.emailAddress` and `organizationUuid`. Two identities name
one login when the emails match ignoring case and the org ids match where both are known
(`sameLogin`, `account-identity.ts`), so one email in two organizations is two accounts, and a row
stored before org ids still matches its own login.

**A row never silently becomes another login.** Every sign-in read goes through `decideIdentity`,
which is pure and idempotent, and the service applies its answer:

| The home now holds | The home's row | The list |
|---|---|---|
| Its own login | Unchanged; a `replaced` row runs again | |
| A login another row names | Keeps its email, `replaced`, usage dropped | The other row is the login's only row |
| A login no row names | Takes the new login, usage dropped | The old login moves to a new folder row, `replaced` |
| A login only a `replaced` row names | Takes the new login | That row takes the old login instead |

A `replaced` row reads as signed out in the tab, with its email and Sign in, and takes no session
and no usage. The new folder row in the third case is there so its Sign in lands in a folder of its
own and never replaces the login the home holds now. Nothing on disk is moved or deleted. A user
with one account is the exception: their row is whatever their CLI is signed in to, as before
accounts, so a new login there adds no row. A list that already names one login twice (written
before this) is settled on the next read: the agent's own home yields, else the newer row, set aside
with no email since the login it held before cannot be known.

A read with no answer, or a signed-in answer with no email, is never a change. Each change is
logged and reported as `identity-changed` with how it was reconciled (`to-listed`, `to-new`,
`merged`, `already-listed`, `duplicate`) and never the email.

**Sessions follow the login, not the home.** A live session keeps two accounts: `homeAccountId`, the
home it was spawned in, which never changes, and `accountId`, the login it runs as. When a home's
login changes, every live session spawned there is re-pointed to the row that names the login the
home now holds (`SessionManager.repointAccount`), and pushed so its context bar follows. Its usage
reports, the continuation at a limit, and Switch to read `accountId`. A background-session stop, a
Command Terminal's reap and the session's record keep the home, which is where the CLI keeps what
they reach. Every session on the home follows, which assumes a running session reads the new login;
probe P2 below decides that.

**Usage never lands on the wrong row.** `refreshUsage` skips a `replaced` row, and after an idle read
it compares the home's state file with the row: a home holding another login is reconciled instead
of stored. `recordUsage` drops a live report stamped with a `replaced` row.

**Detection.** The adapter declares two cheap reads on its account support: `readHomeIdentity` (the
state file, no CLI run) and `loginFiles` (`<home>/.credentials.json` on Windows and Linux, nothing on
macOS, where the login is in the Keychain). For an agent with two or more accounts, Kangentic
watches each home's login file (`account-login-watch.ts`, debounced two seconds, started 20 s
after registration by the usage refresher, since registration reads no database), and checks a
session's home at each turn end and when the session ends. Every scheduled pass checks every `ok`
row the same way. A check runs `claude auth status` only when the state file names another login
than the row. Startup and the tab opening read every row through the CLI, as before. The state file
is parsed again only when its size or time changed. A CLI in a WSL distro keeps its login in the
distro, so its homes get no cheap check and its own home no Sign in from this side.

**Sign in beyond a folder row.** `loginCommand` covers the agent's own home too, run with no home variable as
the user's own terminal does, and `loginEmailArgs` fills in the row's email (`claude auth login
--email`). The browser still signs in whatever claude.ai login it holds. A Sign in that lands
another listed login leaves the row set aside and the dialog names the row that login belongs to.
An Add account that signs in a set-aside row's login hands that row the new folder. Sessions still
running in its old folder keep following the login that folder holds. For the agent's
own home, which cannot move, the new folder keeps the login and the home's row stays set aside with
no email. The tab offers
Sign in on a signed-out or set-aside folder row. The agent's own home has no menu item for it yet:
the backend runs its sign-in, and the item waits for its design.

**An agent switches with a tool, not `/login`.** `kangentic_switch_account` restarts the calling
task's own session on a listed account once its turn ends. Its description, which every agent with
the MCP server reads, says to use it instead of suggesting `/login`
([session tools](mcp-server/session-tools.md#kangentic_switch_account)). The server's instructions
carry no line for it: they are capped at 4,096 characters and the worst case is already at the cap.

Kangentic never refuses or delays a `/login` or `/logout`: no setting, hook or wrapper makes one
fail. Every guard above acts after the command lands. Claude's `forceLoginOrgUUID` would refuse a
`/login` to another organization, so it is not used.

### Probes

The design rests on what Claude does, and some of it is not documented. These run in sandbox homes
only, each swap a real `claude auth login`, never a copied `.credentials.json`, and need the owner's
browser sign-ins, so none has been run yet:

| Probe | Question | Decides |
|---|---|---|
| P2 | Does a running session pick up a login another process wrote to its home? | Whether every session on a home follows a swap, as built, or only the one that ran `/login` |
| P2b | Does a session's token refresh write its old login back over a new one? | Whether a home's identity can flip back, which the reconcile above follows either way |
| P6 | What does a `/login` write, in what order? | That the watched file and the state file change together |
| P7 | What does `/logout` inside a session leave? | That it reads as signed out, never as a change of login |
| P8 | Which login lands with `--email` when the browser holds another? | The Sign in dialog's warning |
| P3, P4 | Does `/login` revoke the replaced login, and does a superseded refresh token revoke its family? | Whether Phase 3 can be built. Destructive: a throwaway login only |
| P5 | Where does `/login` write on macOS for a non-default `CLAUDE_CONFIG_DIR`? | Not measured: no Mac is available |

`node scripts/probe-agent-accounts.mjs logins --agent claude --label <name>` records each sandbox
home's login by the CLI and by its state file, and when its `.credentials.json` last changed, never
a token. Run it before and after each swap.

**Keeping a replaced login signed in is not built.** Doing it means keeping a copy of each home's
login and moving the replaced one into a folder of its own after a swap. Claude rotates its refresh
token, and user reports on its issue tracker say presenting a superseded one can revoke the whole
token family. Until P3 and P4 show a moved login survives with one live holder, a replaced login
stays listed one Sign in away, and macOS stays out unless P5 finds a safe path.

## At a usage limit

With `autoSwitchAtLimit` on, a task's session that reaches its account's limit continues on the
next account (`account-continuation.ts`). A failed turn triggers it when two facts hold together:

1. The turn failed, and the adapter reads the failure as a usage limit.
2. A read of that account, made then, shows it has no room.

A percentage alone never moves a session. The value moves while a turn runs, and a CLI reports a
momentary rate limit with the same error as a spent plan and retries those by itself. The next
account is read before it is chosen. The session then restarts in place on it, resuming the same
conversation with the prompt `Continue.`, and a toast names where it continues. A resume that
starts on a full account is the second trigger, described below, and carries its own opening
prompt instead.

When every account is full, the session waits where it is, one toast names the first reset, and it
continues once a later read shows room. A Command Terminal or a workflow's own agent is not
continued: at its limit it waits as before. A session the continuation is deciding, or holds
waiting, is left to it by a move that follows the order (`isHandling`).

The read that proved an account full is the stored 100, which holds until the window resets (see
"Usage"). So every later spawn, a column move included, passes over that account.

**A resume that starts on a full account is continued too.** A resume Claude refuses at a spent
limit can end with no hook but its start. Measured in task #1147 on 2.1.330: the resumed session's
`events.jsonl` held `SessionStart` (source `resume`), then nothing until the owner restarted it 9
minutes later. No prompt, no `StopFailure`, so no failed turn ever reached the continuation, and
the opening prompt (the Testing column's handoff) never reached the conversation.

A task session's first `SessionStart` now calls `onSessionStarted`. It acts only on a resumed
session (`resuming`). A fresh session at a limit fails its turn, which fires, and a move at its
start could cut it short before its conversation was written. A later `SessionStart` in the same
session, after a compact or a clear, is not a start. When the row of the account it started on
shows no room, or a window at 95% or more (`NEAR_FULL_PERCENT`, since a spent account reads 99),
the session is decided as a limit would be. Its account is read, and only a read that finds it full
moves it, or leaves it waiting with every account full. The percentage decides whether to read,
never whether to move. The move restarts the session with its own opening prompt, read from its
session record, never `Continue.`, since that prompt was never answered. A session that started
with none resumes idle. A failed turn on a session already waiting this way keeps its opening
prompt. An account under 95% costs nothing, and no read runs. The check catches three starts: a
spawn named to a full account, a spawn made while every account was full, and a spawn on an account
whose stored 99 came from a live report before any read stored its 100. The call runs off the event's stack and is
never awaited, since the spawn may still hold the task's lock that a restart takes.

A session moved during its return recap keeps the column's message waiting on that recap: the
restart carries the recap mark to the session that replaces it (`carryRecapAcross`), so the
message goes there once the replacement's recap turn ends, never dropped with the old session. A
restart that resumes idle, with no prompt, takes no recap turn, so the message goes at once. While
the session waits with every account full, the recap's 20-minute bound is paused.

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
`accountUsageLines` (`utils/rate-limit-window.ts`), one per declared window the account has and
then any other window the CLI reported. A declared window the account does not have draws no line,
so two rows of one agent can differ in height. A reset reads as a countdown (`41m`, `3h 14m`, `1d 4h`) and its tip gives
the moment. The percent beside the bar is what is used. The bar's tip says how much of the window
has passed, which is what the tick on the bar marks.

While it waits, the tab never goes blank (task #1202). An empty, unchecked list draws one skeleton
card: its icon and name are still bars (`SettingsCard`'s `placeholder`), the header has an empty
outline the size of Add account, and one `AccountRowSkeleton` row is built on `AccountRow`'s own
layout. That row is 104 px, the same as a real row with two usage lines, so a first account lands
in its place. "No agents with accounts" shows only once a checked list is empty. The tab's own usage
read takes 13 to 35 s, and while it runs each card whose agent reports usage has a spinner after its
name, with the tip "Reading usage" (`usageReads` in the accounts store). The bars meanwhile show the
last saved read, and a window whose reset has passed draws as Not started. None of these swaps
animates, so a restore replays nothing.

## Signing in

Add account runs the CLI's own sign-in (`claude auth login`) in a terminal of its own
(`account-login.ts`), pointed at a new account folder. It is a raw PTY in the pty host and not an
agent session, so it has no registry row, no hooks and no task tag. Kangentic reads nothing from
that screen. When the terminal ends, `identify` asks the CLI who signed in. A login already in the
list (the same email and, when both report one, the same organization) adds nothing, and the dialog
names the existing account. A sign-in that did not finish removes
the row it made, and so does one whose terminal could not start. The folder stays. The dialog opens
on the click, with the terminal's box empty, because main may first have to find the CLI. Closing it
before main answers cancels the sign-in that then starts.

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
| `folder-link-failed`, `folder-entry-user-owned`, `folder-entries-kept-aside` | An account folder's link or copy could not be made, an entry there was not Kangentic's to replace, or what the folder held was the account's own and was kept aside (a clashing entry, a `CLAUDE.md` a person wrote). With the entry's name, `blocksAccount` and `default_home`. A `folder-entry-user-owned` also carries `shape` (`link-elsewhere`, `file`, `link` or `not-a-file`, sent as its `reason` too) and, for a link, `link_target`: where the link points by the path it names, as `builtin-home`, `kangentic-account`, `recorded-home` or `other`. |
| `folder-change-replaced` | A setting, server or approval changed from a session on an account was replaced by the home's at that account's next spawn. With the entry's name (`settings.json`, `.claude.json`), never what changed. |
| `spawn-account-unresolved` | An agent had accounts and none could be prepared, so the spawn ran on the agent's own login. |
| `sign-in-not-recognized` | A sign-in's terminal ended by itself and no login read back. Unproven agents only. |
| `session-not-signed-in` | A session on an account read as signed in started signed out. Unproven agents only. |
| `turn-failed-after-move` | A turn failed within ten minutes of its session being moved to another account. |
| `conversation-refused` | A turn failed with the adapter's words for a conversation tied to another account (`isConversationRefusal`). |
| `usage-read-unreadable` | The CLI answered a usage read in a shape the adapter does not know, with the answer's field names (`keys`). For Claude, a fresh cache whose `utilization` names none of the known windows, or is missing or not a record. |
| `usage-read-empty` | A usage read gave no windows, with the account's kind and a fixed reason (`run-failed`, `state-unreadable`, `state-not-record`, `no-cache`, `cache-stale`, `no-windows`, `no-answer`). `no-cache` is not sent for an account that never stored a reading. `run-failed` is sent from the second failed run in a row, with the tags `run_failure`, `run_exit` and `agent_cli_version`. `cache-stale` is sent from the second stale read in a row, with `cache_age` (`under_1h`, `1h_to_1d`, `over_1d` or `unknown`) and `agent_cli_version`. `no-windows` carries `agent_cli_version`. |
| `identity-read-failed` | A sign-in read gave no answer, with the account's kind and a fixed reason (`run-failed`, `unreadable`). The account kept its status. `unreadable` is sent on the first read. `run-failed` is sent from the second failed run in a row, counted apart from usage reads, with the tags `run_failure`, `run_exit` and `agent_cli_version`. |
| `identity-changed` | A home's login was replaced, with the account's kind, how it was reconciled (`to-listed`, `to-new`, `merged`, `already-listed`, `duplicate`) and `default_home`, or `stage: repoint` when its sessions could not be moved. |

Only fixed facts are sent: the agent, the problem, an entry's name, a count. Never a folder path,
an email or a key. `default_home` says where the agent's own home came from, never the home
itself. It is one of four words:

- `builtin`: no home variable was set.
- `inherited`: a home variable the app was started with.
- `login-shell`: one the login shell exports, taken at startup.
- `inherited-ignored`: one that named a Kangentic account folder and was dropped at boot.

`shape`, `link_target` and `cache_age` are fixed words of the same kind. None of the four adds a
data class, so Settings > Privacy is unchanged.

A provider's own error text is never sent, because its words can name the
user's organization: a `detail` fact goes as its class (`classifyFailureDetail`: `usage_limit`,
`auth`, `network`, `server`, `refused`, `empty` or `other`) and its length. A caller's error goes
as its class and errno only. A caller's tag is kept only when its value is one short token (a
fixed word, a number, a version), so no path or sentence can ride one. Each problem reports once
per agent and fixed `reason` per run, whatever its other facts, fingerprinted
`['agent-accounts', problem, agent]`. An adapter marks itself `unproven` while its declaration
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
- A change made from a session on an account to a copied or rebuilt file is reported, not kept:
  the home's copy replaces it at that account's next spawn. Copying it back into the home is not
  built.
- A folder an account filled before it was linked moves into the home by rename. With the account
  folder on another drive, or a file in it held open on Windows, what cannot move is kept aside
  under `.kangentic-kept-<time>` and reported, and the account reads the home's folder from then
  on. Both folders sit under the user's profile unless the config folder was moved.
- A lock on an account's `.claude.json` that outlasts its budget fails that refresh, and the spawn
  passes the account over. Problems found earlier in that one refresh are not reported.
