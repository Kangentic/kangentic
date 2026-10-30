# @kangentic/protocol Changelog

<!-- releases -->

## [Unreleased]

Tells a phone what an agent's wait is for, carries a Notify me automation row
to the phone, and holds a phone's message for a paused task. Additive on the
wire; `PROTOCOL_VERSION` stays '3'.

`ActivityReasonWire`'s `permission` variant gains an optional `waitKind`:
`question` when the agent asked the user something, `approval` when it wants a
tool allowed or a plan approved. Absent means the agent did not say. The set is
exported as `PERMISSION_WAIT_KINDS`, with `PermissionWaitKindWire` and
`isPermissionWaitKindWire`. `parseActivityReasonWire` reads a reason off the
wire and drops a `waitKind` it does not know, so a kind a newer desktop adds
costs the field, not the event. `parseActivityEventPayload`,
`parseReadStreamResponsePayload` and `parseCommandTerminalWire` read the reason
through it. `isActivityReasonWire` stays a strict guard.

`PushEnvelopePlaintext` gains three optional fields, each dropped rather than
rejected by `parsePushEnvelopePlaintext` when malformed or unknown:

- **`waitKind`**, on an `input-required` push from a session's wait. A phone
  that knows it titles the push "Agent has a question" or "Agent needs your
  approval". One that predates it keeps "Agent needs your input". A workflow
  task's notice carries none.
- **`title` and `body`**, set together by a Notify me automation row: its own
  Title and Body. The push is an `input-required` with an empty `sessionId`, so
  a tap opens the task and a phone keys it by task, the identity a workflow
  task's notice already uses. `detail` carries the Body too, so a phone that
  predates the fields shows "Agent needs your input" over "task - body". The
  desktop sends it to every paired device, whatever its categories and whether
  or not it is connected, with no cooldown, and never clears it.

`send-user-message` to a session with no running agent (a paused, queued or
exited task session) no longer refuses. The desktop holds the message for the
task's next agent and answers `delivered: true`. A hold the desktop refuses (a
task in Done, a message too long to hold) answers with the refusal and code it
sent before. A Command Terminal is refused as before.

### Features
- Carry the wait's kind on the activity reason and the input-required push
- Push Notify me automation rows to every paired phone
- Hold a phone's message for a task with no running agent

## [protocol-v0.25.0] - 2026-10-28

Lets a phone hold one workflow task out of its workflow with the task's own
automations switch, while the rest of the workflow runs. Additive on the wire;
`PROTOCOL_VERSION` stays '3'.

`BoardTaskWorkflowWire` gains an optional `automations_pausable`. It is true on a
desktop that honours `automationsDisabled` on a workflow task: `update_task`
accepts it, and while the switch is on the workflow neither judges, moves nor
starts the task. A held card's `lock_reason` reads null, and a hand may move it
to any column but To Do. Null or absent means an older desktop, which refuses
`automationsDisabled: true` for a workflow task, so a phone offers the switch
on a workflow task only while the field is true. `parseBoardTaskWorkflowWire`
populates the key from every wire response.

The `automations_disabled` doc comment follows the desktop's rename: its menu
row is Pause or Resume automations, and its strip reads "Automations paused".

### Features
- Hold one workflow task out of its workflow with Pause automations (0a0f4131)

## [protocol-v0.24.0] - 2026-10-27

Gives a phone a completed task's full report, and lets it list and resume the
conversations of Command Terminals that ended. Additive on the wire;
`PROTOCOL_VERSION` stays '3'.

`get_task_report` joins `BOARD_TOOL_READ_NAMES`, so a phone reads it through its
existing `board-tool-read` grant. Its result is a `TaskReportWire`, narrowed by
`parseTaskReportWire`. It carries:

- **The task's span.** `startedAt` is the earlier of its first move into a
  working column and its first session start. `endedAt` is its last move into
  Done, else its last session end.
- **Its route** through the board's working columns, with the time and the stays
  in each.
- **The commits** the desktop's index links to it.
- **Its per-file changes**, read from git, with their totals.
- **`summaryState`**, which says whether a task summary is written and, when it
  is not, why: `pending`, `off` or `indexing-off`.

Lists are capped (200 files, 100 commits, 50 stays per column) and carry their
full counts. A git failure costs only `changes`, and `changesError` says why. The
parser degrades an unknown file status, summary kind or empty reason instead of
throwing, so a newer desktop never breaks an older phone. A desktop older than
this version refuses the tool as not allowed, and a phone falls back to
`find_task`.

The `command-terminal` verb gains two actions:

- **`list-earlier`** answers with a `CommandTerminalEarlierResponsePayload`: the
  project's ended Command Terminal conversations that can still be resumed,
  newest first. Each is named by its `agentSessionId`, with a `name` (the
  terminal's, else its first prompt, else null) and `endedAt`.
  `parseCommandTerminalEarlierResponsePayload` drops a malformed row on its own.
- **`resume`** starts a terminal on one of those conversations and is answered
  like `start`. It adds two refusal codes: `conversation-gone` (it can no longer
  be resumed, so drop the row) and `conversation-open` (a live terminal holds it,
  or another resume is starting it).

Send either action only when the snapshot's new `earlierConversationsOffered` is
true; an older desktop refuses both as malformed.

The `automations_disabled` doc comment is corrected. The desktop clears the
switch by itself only when a task joins a workflow; a move out of Done or a
restore from the archive keeps it.

### Features
- Give the phone a completed task's full report (267209f5)
- List and resume earlier Command Terminal conversations from a phone (67282452)
- Name earlier Command Terminal rows by their first prompt (ebb2042a)

### Fixes
- Point split-doc citations at the concept that holds each fact (2e31ac76)

### Other
- Share protocol guards and skip the task report's unused web links (7d9464f7)
- Drop stale Done-clear notes from the automations switch's doc comment (69c2f7fc)
- Point the README at the split mobile-bridge docs (7639f8e3)

## [protocol-v0.23.0] - 2026-10-18

Lets the desktop clear notifications that have resolved. Additive on the wire;
`PROTOCOL_VERSION` stays '3'.

A new sealed clear message (`sealPushClear`, `openPushClear`) is built like the
notification envelope: XChaCha20-Poly1305 under the device's push key, the
recipient's static public key as AAD, base64url, and the same 24 hour freshness
window. It rides the push payload under `data.clear` (`PUSH_CLEAR_DATA_KEY`)
instead of `data.blob` (`PUSH_ENVELOPE_DATA_KEY`), so a phone tells a clear
apart before it decrypts anything. `sealedPushBlobLength` returns the length a
plaintext would seal to, so a sender can fit a message under a push payload
limit without sealing it first.

Each `PushClearEntry` names the notification it clears by copying `category`,
`projectId`, `taskId`, `sessionId` and `sessionKind` from that notification's
envelope (spawn-stalled's `sessionId` is empty), plus `notifiedAt`: the `sentAt`
of the newest notification it covers. A phone removes a displayed notification
only when its category and ids match and its own `sentAt` is at or before
`notifiedAt`. That bound keeps a clear that Doze held back from removing a newer
alert for the same session and category.

`PushEnvelopePlaintext` gains an optional `clears` list, so pending clears can
ride the next visible notification. A phone applies them before it shows that
notification. Entries are parsed tolerantly (`parsePushClearEntries`): an entry
with an unknown category, a non-string id or a non-finite `notifiedAt` is dropped
on its own, an unknown `sessionKind` is omitted, and a malformed list never costs
the notification it rides on.

`register-push` gains an optional `acceptsClears` boolean. The desktop sends a
standalone clear, or piggybacks `clears`, only to a registration that set it,
because an older Android app shows the generic placeholder for any message it
cannot open and a clear would arrive there as a new notification. An older phone
never sets the flag, so nothing changes for it.

On the desktop side, with no wire change: a clear goes out when a notified
condition resolves at the desk. The desktop batches a device's clears for a few
seconds and keeps a message under Expo's 4096 byte payload limit. Android gets a
data-only message at normal priority. iOS gets a background push (no alert) at
most once per device every 20 minutes, and keeps its entries pending until a
visible notification carries them or 24 hours pass.

### Features
- Send sealed clears when a notified push condition resolves (5331356f)

## [protocol-v0.22.0] - 2026-10-17

Sends a task's automations switch to the phone. Additive on the wire;
`PROTOCOL_VERSION` stays '3'.

`BoardTaskWire` gains an optional `automations_disabled`. It is true when column
automations are off for the task: no On task enter, On agent turn end or On task
exit row runs for it, and a move types no column message. It is the fact the
desktop card's "Automations disabled" strip reads. Null or absent means a
desktop older than 0.22.0, and a phone offers no control then.

There is no new verb. A phone flips the switch with its existing
`board-tool-write` `update_task` call and the camelCase param
`automationsDisabled`, never `automations_disabled`. A workflow task always reads
false and `update_task` refuses `true` for one, so a phone hides the control
while `workflow` is non-null. The desktop also clears the switch by itself when
a task leaves Done (a rollback excepted), is restored from the archive, or joins
a workflow, and each of those reaches the phone as a `task-updated` board event.

On the desktop side, with no wire change: every desktop task write (create,
edit, delete, restore from the archive, branch switch, a model pin, a backlog
promote or demote) now emits a board event. Before, a subscribed phone heard of
such a write only when something unrelated fired, so a flip from the desktop
card menu left the phone's board stale. A backlog label rename or delete still
emits nothing.

The `SessionSummaryWire` doc comment states the desktop's corrected roll-up for
a completed task. Cost, duration and tokens count once per conversation and add
across conversations, tool calls and lines sum, and files changed takes the
max. The shape is unchanged, but a desktop that ships this version no longer
counts a resumed conversation's cost and runtime once per resume, so those
values read lower for a task that was resumed.

### Features
- Send a task's automations switch to the phone, announce desktop task writes (9d5c8d70)
- Fix the cost and agent runtime roll-up and redesign the completed task view (24368335)

## [protocol-v0.21.0] - 2026-10-12

Adds workflows to the bridge: a workflow is a set of linked tasks that runs
through its boards by itself, starting each task when the tasks it waits for
reach Done and moving it along its route of columns. A phone can see a task's
workflow on its card, see why a card cannot be moved, and pause or resume a
workflow. Additive on the wire; `PROTOCOL_VERSION` stays '3'.

`BoardTaskWire` gains an optional `workflow` (`BoardTaskWorkflowWire`, or null
for an ordinary task): `id`, `title`, the home `project_id` (which may not be the
board's), `state` (`running`, `paused`, `draft` or `done`; an unknown value reads
as running), `color_slot` (1 to 6, the desktop's categorical color for the
workflow's icon), `route` (the column ids it visits, in board order),
`waiting_for` (the unfinished tasks it waits for, named by display id as the
card's footer names them), `lock_reason` (the desktop's sentence for a refused
move while the card is locked, null when a hand may move it) and
`gate_target_id` (while the card waits in a column no agent judges, the one
column a hand may move it to). `parseBoardTaskWorkflowWire` is lenient: an
absent or malformed value reads as null, so an older desktop or a broken
workflow costs the card its strip, never the board.

`list_workflows` and `get_workflow` join `BOARD_TOOL_READ_NAMES`, and
`pause_workflow` and `resume_workflow` join `BOARD_TOOL_WRITE_NAMES`. Planning,
Start and Delete stay on the desktop.

`PUSH_CATEGORIES` gains `workflow-complete`, sent when every task of a workflow
reaches Done. Its `taskTitle` is the workflow's name, and its task and session
ids are empty. A phone that predates it shows the generic placeholder.

On the desktop side, with no wire change: `move-task` refuses a locked card
before it commits, and `start-session` refuses a task in a paused workflow, both
with the desktop's sentence.

### Features
- Add Workflows, linked tasks that run through the board on their own (f349d19a)

## [protocol-v0.20.0] - 2026-10-11

Adds Command Terminals to the bridge: a phone can start an agent at a project's
root, stop one, list them with their activity, and read a project folder's diff.
Additive on the wire; `PROTOCOL_VERSION` stays '3'. One TypeScript type changes
(see Types below), which a consumer sees at its version bump.

New verb `command-terminal` (the 13th in `CAPABILITY_VERBS`). The request is
`{ action: 'start', projectId }` or `{ action: 'stop', sessionId }`, and the
parser copies out only those fields, so a branch, model or effort never reaches
the desktop. Start answers `{ ok: true, sessionId, slot, name }` once the spawn
returns, with `slot` 1 to 4 and `name` the terminal's display name. Stop answers
`{ ok: true }`. It starts an agent, never a shell, and the desktop ends the
session when the agent exits. `parseCommandTerminalStartResponsePayload` is the
phone-side parser. The verb rides each device's own grant like every other verb.

Typed refusals, each with an exported constant: `unknown-project`,
`unknown-session` (a stop for a terminal that already ended, which a phone treats
as stopped), `command-terminal-limit` (the project already runs four),
`not-command-terminal` (a stop that named a task's agent, nothing stopped),
`agent-unavailable` (the project's agent CLI is not installed) and
`command-terminal-start-failed` (anything else, with `error` kept for logs). A
phone shows a generic line for a code it does not know.

The `read-board` snapshot, in the full view and in `view: 'sessions'`, gains
`commandTerminals` (`CommandTerminalWire`: `sessionId`, `projectId`, `slot`,
`name`, `named`, and the raw `activity` state and reason for the first paint) and
`commandTerminalsOffered`, true when the device holds the verb. Both parse through
`parseCommandTerminalWire` and `parseReadBoardResponsePayload`.

The board event gains the change `command-terminals-changed`, with `ids` set to
`[sessionId]` and no `taskId`. It fires on a terminal's start, end and rename
only, never on an activity change: a phone subscribes `read-stream` for each
terminal's `sessionId` and gets live state and reason from that stream.

The push envelope gains an optional `sessionKind`, `'command-terminal'`
(`PUSH_SESSION_KINDS`, `isPushSessionKind`), with the terminal's name in
`taskTitle`. The parser drops an unknown kind instead of throwing.

`read-diff` with no `taskId` diffs the project folder against the project's
default base branch, and its subscription pings carry `projectId`. `filePath`
stays limited to the diff's own file list.

### Types
- `ReadDiffRequestPayload.taskId` is optional.
- `DiffEvent` carries exactly one of `taskId` and `projectId`, and the event
  validator rejects both or neither.

### Features
- Run Command Terminals over the bridge and end them with their agent (9e6831b4)

### Fixes
- Harden Command Terminal starts, ends and naming tests (fd92746c)

## [protocol-v0.19.0] - 2026-10-08

Adds the code a desktop puts on a refusal for a response that would not fit the
frame caps, and the check that decides it. Additive; `PROTOCOL_VERSION` stays '3'.

`CapabilityErrorCode` gains `response-too-large`, with
`RESPONSE_TOO_LARGE_ERROR_CODE` beside `UNSUPPORTED_VERB_ERROR_CODE`. It means the
request was valid and its target still exists, so a client must not read it as the
target being gone (a session ending, a project removed). A phone should keep the
`code` on the error it raises for a refused request and branch on it, because a
client that reads every refusal as "session gone" shows a live session as ended.
An older peer's decoder drops the unknown `code` and keeps the `error` text.

`encodeMessageFailure(message)` returns why `encodeMessage` would throw for a
message, or null when it would not, without keeping the frame. Raw UTF-8 JSON at or
under `MAX_FRAME_LENGTH` returns null after one stringify, and a larger message
runs the real encode, so the verdict is exact.

The desktop build that ships this version never refuses a terminal `read-stream`
subscribe for size. When the seed would push the response over the caps (4 MiB of
JSON before compression, 1 MiB after), it re-takes the seed with less history,
then the grid alone, then an empty seed, and answers ok. A verb that cannot send
less is refused with `{ ok: false, error: 'Response too large to send', code:
'response-too-large' }`. A desktop older than this build sends nothing for an
oversize response, so the request times out.

### Fixes
- Shrink an over-cap terminal seed instead of refusing it (871fa89e)
- Refuse an over-cap read-stream subscribe before subscribing (5233c173)
- Probe a prompt that rises mid-shrink on the re-take frame (cd102e65)

### Other
- Move the encode verdict into the protocol beside encodeMessage (5031c257)

## [protocol-v0.18.0] - 2026-10-07

Lets a phone pause a running session the way the desktop Pause button does.
Additive; `PROTOCOL_VERSION` stays '3'.

`CAPABILITY_VERBS` appends `pause-session` after `start-session` (append only:
the desktop mirrors the tuple index for index). The request is
`PauseSessionRequestPayload` (`taskId` + `projectId`, keyed by task, never by
session id), the response is `PauseSessionResponsePayload` (`{ ok }`), and
`parsePauseSessionResponsePayload` narrows it phone-side. The desktop answers
once the pause is recorded, while the agent's shutdown is still running, and the
paused state reaches the phone as a `task-updated` board event whose snapshot
reads `paused: true`. A task with no live session is refused with `ok: false`. A
0.15.0 to 0.17.0 desktop refuses the verb with the `unsupported-verb` code, and
an older one never answers it.

`BoardTaskWire` gains `pausable`: true when the task has a `running` or `queued`
session and is not in To Do. Done and archived do not clear it, matching the
desktop. It is never true while `paused` is true, and it reads false while
`spawn_progress` is up with no live session, where the verb would refuse. Gate a
phone's Pause on it. Null or absent means a desktop older than 0.18.0, and a
client offers no Pause then.

The desktop build that ships this version also refuses a `projectId` it does not
know on `move-task`, `start-session` and `pause-session`, with
"No such project: <id>", as `read-board` and `read-diff` already did.

### Features
- Add a pause-session verb so the phone can pause a running session (5a448a6a)

### Other
- Say the desktop draws no Paused footer on archived cards (3ec860ce)

## [protocol-v0.17.0] - 2026-10-07

Sends a task's paused state to the phone apart from the Resume gate. Additive;
`PROTOCOL_VERSION` stays '3'.

`BoardTaskWire` gains `paused`. It is true when the task has a paused session (a
`suspended` session that is not a Command Terminal) and no live one, whatever its
column and whether or not it is archived. It is the fact the desktop card's
"Paused" footer reads, so a paused task in Done or on the archived page now sends
`paused: true, resumable: false`. Before, `resumable` was the only paused signal on
the board row, and a pause clears `session_id`, so the phone had no way to know a
suspended session existed there. `resumable` stays the Resume gate, and
`resumable: true` always comes with `paused: true`. A respawn queued behind the
desktop's concurrency limit reads `paused: false`, as the desktop card shows the
queued session. A `spawn_progress` label still overrides it, as on the card.

Null or absent means a desktop older than 0.17.0, and a client then reads a paused
task from `resumable` alone, as before. `view: 'sessions'` is unchanged on
purpose: it keeps a resumable paused task and leaves out one that offers no
Resume, even though that row now reads `paused: true`, because an agent feed has
nothing to act on for it.

A move into To Do removes the task's session rows on the desktop, so a task paused
before that move sends `paused: false`, which matches the desktop card.

### Features
- Send a task's paused state apart from `resumable` on the board row (7e512cc5)

### Other
- State the paused rule once and tighten its doc comments (baa3fa39)

## [protocol-v0.16.0] - 2026-10-06

Sends the desktop card's in-between states to the phone, and lets a phone
resume a paused task the way the desktop Resume button does. All additive;
`PROTOCOL_VERSION` stays '3'.

`BoardTaskWire` gains `spawn_progress` and `resumable`. `spawn_progress` is the
card's preparing label, such as "Creating worktree..." or "Switching model...",
and the desktop announces each change with a `task-updated` board event, at most
about once a second per task. It is untrusted display text. The desktop strips
escape sequences and control, invisible and tag characters and caps it at 120
characters, but a client still caps it for its own layout. A label overrides a
`suspended` session status, never `running` or `queued`. `resumable` is true
when the task's session is paused and the desktop would offer Resume for it.
Both parse as null when absent, which means a pre-0.16.0 desktop. Under
`view: 'sessions'` a task with a label, or a resumable paused task, is kept
while its `session_id` is null.

A new `status` activity payload carries `status`, `resuming` and `resumable`
whenever one of them changes after the read-stream snapshot, for the same
session id only. The snapshot gains `resuming` and `resumable`, and
`isReadStreamSessionStatusWire` is exported. A resume always mints a new
session id, so a feed held on a paused session ends with
`session-ended { intentional: true, successorSessionId }` and the phone
subscribes to the successor. Each new signal is an activity payload type rather
than a new event kind, so an older phone drops just that event through
`isBridgeEvent`.

`resumable` is the desktop's promise that `start-session` resumes the paused
session as its Resume button does: the same conversation, a "Resuming
session..." label, and no enter automations or column message. A pre-0.16.0
desktop starts the column instead, so a client offers no Resume when the field
is null or absent. Gate Resume on the board row's field, not the stream's copy,
because a pause clears `session_id` and the phone then holds no stream on the
paused session.

### Features
- Send spawn progress, resuming and live session status to the phone (fd8c72ac)
- Flag a paused task that `start-session` will resume like the Resume button (8d7179fa)
- Put `resumable` on the board task row, where a phone can see a paused task (67120bcc)
- Keep a resumable paused task in the `'sessions'` board view (a3101c6b)

### Fixes
- The `spawn_progress` doc comment says the desktop sanitizes the label for the wire (46e54c2e)
- The `spawn_progress` doc comment names the invisible format characters the desktop strips (1bca46a2)
- The `status` and read-stream `resumable` doc comments say that copy can stay true after a move to Done or an archive (e586550c)
- The `spawn_progress` doc comment says the desktop strips tag characters (874d5823)
- The `spawn_progress` doc comment says only the England, Scotland and Wales flag emoji keep their tag characters (93878e56)

### Other
- The `SessionUsageWire.toolCallCount` doc comment says it counts every run of the session (4389ef4b)

## [protocol-v0.15.0] - 2026-09-18

Adds the `start-session` capability verb, so a phone can start a task's session
again in the column the task is already in, and makes a verb the receiver does
not know answerable instead of a silent drop. Both additive; `PROTOCOL_VERSION`
stays '3'.

`start-session` is appended to `CAPABILITY_VERBS` (append only: the desktop
mirrors the tuple index for index), with `StartSessionRequestPayload` (`taskId`
plus `projectId`), `StartSessionResponsePayload` (`{ ok, outcome: 'starting' |
'live' }`), `StartSessionOutcome`, and the guard `parseStartSessionResponsePayload`.
The verb answers when the start is ACCEPTED, not when the agent is up: on
`starting` the successor's arrival reaches the phone as the board and stream
events a column move already produces; on `live` a session was already running,
nothing was spawned, and no event is coming, so a phone that tapped Start from a
stale screen refreshes its board and stream itself. `live` also covers a session
queued at the desktop's concurrency limit, so read it as "coming", not "running".
A post-accept failure is reported on the desktop only, so the waiting screen
needs its own timeout and a retry.

`decodeMessage` now validates a capability-request's envelope (a string
`requestId`, a string `verb`, a JSON `payload`) before verb membership, and when
only the membership check fails it throws a typed `UnsupportedVerbError` carrying
the `requestId` and `verb`, so a receiver can answer the request instead of
dropping the frame. A malformed frame still throws a plain `Error` and stays a
silent rejection. `isUnsupportedVerbError` keys on the error's name and fields
rather than `instanceof`, because a consumer of the published dist and a
workspace-source consumer can hold two copies of the class.
`CapabilityResponseMessage` gains an optional `code?: CapabilityErrorCode` (one
member today, `UNSUPPORTED_VERB_ERROR_CODE = 'unsupported-verb'`), validated by
shape only, so a code an older peer does not know cannot cost it the `error` text
it can still show. A desktop from this version on answers an unknown verb with
`{ ok: false, error: 'Unsupported verb: <name>', code: 'unsupported-verb' }`
without running any handler. A desktop older than this version still drops the
frame and the phone times out, so the refusal helps for every verb added after
`start-session`; a client should key its "update your desktop" copy on `code`,
never on the `error` text.

### Features
- Add a start-session verb so the phone can start a task's session again (c910d20e)
- Answer an unknown capability verb with a refusal instead of dropping the frame (6afe2e06)

### Fixes
- The `spawnProgressLabel` doc comment on the session-ended payload also names an in-place restart, such as a re-sent command (38f5b44d)

### Other
- `isUnsupportedVerbError` binds its field cast once (0fdfc4b6)

## [protocol-v0.14.0] - 2026-09-13

Adds an optional `spawnProgressLabel` to the `session-ended` activity payload,
carrying the desktop's in-flight spawn-progress label (for example "Switching
model..."). Additive, and `PROTOCOL_VERSION` stays '3': absent from pre-0.14.0
desktops, and never sent as `null`.

Presence means the desktop had a respawn in flight for this task when the
session ended, so a client can tell a same-column respawn (model, agent, effort
or session-track switch) from a genuine park. `intentional` cannot carry that
distinction on its own, because `SessionManager.suspend()` sets
`status = 'suspended'` before the force-kill for a respawn and a real park
alike, and both reach a client as `intentional: true`.

Read it as INTENT, not a guarantee, on the same terms `BoardColumnWire.spawns_session`
documents. The desktop can suspend without a successor ever landing, and five
park paths do not clear the label first, so a client MUST keep whatever timeout
already bounds its session-swap wait and use the label only to skip a redundant
one. The string is the desktop's own display text: treat it as untrusted, cap
its length, and fall back to generic copy rather than parsing it.

### Features
- Add `spawnProgressLabel` to the session-ended activity payload (b528e3e6)

## [protocol-v0.13.1] - 2026-09-12

`BoardTaskWire.pr_merge_readiness` becomes optional (`?: string | null`),
matching `BoardColumnWire.spawns_session`. It shipped required in 0.13.0 even
though `parseBoardTaskWire` already reads an absent key as null, so the
required declaration bought nothing and forced every consumer that hand-builds
a `BoardTaskWire` literal to list a field the parser already defaults.

No runtime or parse behavior changes and `PROTOCOL_VERSION` stays '3'. One
direction is worth naming for readers: the field's type now includes
`undefined`, so a consumer that reads it under `strict` without handling that
case needs a check it did not need before. Producers are strictly freer.

### Fixes
- Make `BoardTaskWire.pr_merge_readiness` optional (a9624bac)

## [protocol-v0.13.0] - 2026-09-11

Adds `BoardTaskWire.pr_merge_readiness` and `BoardColumnWire.spawns_session`.
Both are additive and neither moves `PROTOCOL_VERSION`: `parseBoardTaskWire`
reads an absent readiness key as null, so a desktop that predates the field
looks exactly like one that has never judged a PR. A client that does not
recognise a readiness value should render the PR as plain open, which keeps
`queued` and `running` from breaking a phone built against the first four
values.

### Features
- Show merge readiness on the PR pill, resolved per adapter (5ab77a75)
- Fold Azure branch policies into merge readiness and report in-flight checks (44dd7abd)
- Narrow `BoardColumnWire.role` and add `spawns_session` (f163b588)

### Fixes
- Correct the `spawns_session` false contract and pin the wire round trip (e03fa313)

## [protocol-v0.12.0] - 2026-08-06

Wire `PROTOCOL_VERSION` goes '2' -> '3'. All peers must upgrade together, and
every already-paired device must re-pair.

### Breaking Changes
- The pairing relay slot is derived from the pairing token instead of being
  the token, via the new `derivePairingSlotId()` (ac5565b8)

  The 32-byte token was doing three jobs: the single-use pairing token, the
  Noise `IKpsk0` PSK, and, hex-encoded, the relay slot id sent as a cleartext
  `?slot=` query parameter. The third published the second. On a hosted relay
  TLS terminates at the edge, which therefore saw the PSK, as would anything
  logging request URIs, so `IKpsk0` degraded to plain `IK` for such an
  observer and the `psk0` contribution bought nothing against them.
  `derivePairingSlotId()` is a labeled BLAKE2s hash of the token, 16 bytes,
  matching `deriveSessionSlotId`'s shape. The routing label stays public, the
  PSK stays secret, and the token never leaves the QR code. No relay change is
  required: the relay's default slot-id pattern already accepts a 32-hex slot.

  `PROTOCOL_VERSION` is bumped because a slot is a zero-negotiation rendezvous
  value: peers deriving it differently never meet, and would otherwise hang
  until the relay's park timeout. Binding the version turns that into an
  explicit version-incompatible result at QR-scan time, before anything dials.
  The version is bound into the KK session prologue as well, which is why
  existing pairings must be re-established.

### Fixes
- A pairing ceremony can no longer be ended by an unauthenticated frame
  (ac5565b8)

  The desktop marked the pairing token consumed on the first frame received,
  before `readMessage` authenticated anything, so anyone able to deliver one
  frame to the pairing slot burned the ceremony deterministically while
  holding no key material. Since the slot id needed to deliver that frame was
  the token itself, travelling in cleartext, that was reachable by anyone who
  could read a request URI or photograph the QR. The token is now consumed
  only after a frame authenticates, and frames that fail to authenticate are
  ignored rather than ending the ceremony, in both the waiting-for-phone and
  sas-pending phases.

  Reordering alone is not sufficient: `readMessage` advances the message index
  and mixes the sender's ephemeral into the transcript before it can
  authenticate, so a rejected frame left a shared `HandshakeState` poisoned
  and the legitimate peer's later attempt failed anyway. Each inbound frame
  now gets its own responder handshake, committed only once it authenticates.
  Ignoring a failed `openPairingConfirm` is safe because `CipherState`
  advances its nonce only on a successful decrypt.

  This is abort-the-ceremony, not compromise-the-ceremony: impersonating a
  peer still requires the desktop's static key, which never crosses the relay.

## [protocol-v0.11.1] - 2026-07-26

### Fixes
- `isSecureRelayAddress` parses the URL authority instead of prefix-matching
  it (1a6b492f)

  `ws://127.0.0.1:8080@evil.test` returned true. Everything before an '@' in
  a URL authority is credentials, so that address dials evil.test, and the
  pairing token IS the Noise PSK, dialed verbatim as the relay's `?slot=`.
  One crafted QR field therefore put the PSK on the wire in cleartext to an
  attacker-chosen host, which was then persisted to the trust anchor for
  every later session. The loopback carve-out is not behind a dev gate, so
  this applied to production builds. Parsing subsumes the old boundary check
  (`localhost.evil.com` is simply a different host rather than a prefix
  needing a special case), and the IPv6 branch rejects trailing garbage
  after the closing bracket rather than trimming to it.

## [protocol-v0.11.0] - 2026-07-26

All additive; wire `PROTOCOL_VERSION` stays '2'.

### Features
- project groups on the project listing: `ReadBoardProjectGroup`, optional
  `groupId` / `position` on `ReadBoardProjectSummary`, and an optional
  `groups` array on the project-list response (c606221f)

  A malformed group entry is dropped rather than failing the whole listing:
  the projects are what the phone cannot work without, and grouping degrades
  to the flat list it rendered before.

## [protocol-v0.10.0] - 2026-07-26

All additive; wire `PROTOCOL_VERSION` stays '2'.

### Features
- read-board `archived` action: one page of completed tasks, newest first,
  each carrying its lifetime session summary (4ac99209)

  An action rather than a field on the snapshot, deliberately: a board
  subscription re-snapshots on every board change and the archive only
  grows, so folding it in would re-send an ever-larger payload for the life
  of the connection, the exact cost the 0.9.0 projections were added to
  remove.

### Fixes
- the board-profile commands are classified for the phone's capability
  allowlist (81ac8ee6)

## [protocol-v0.9.0] - 2026-07-24

All additive; wire `PROTOCOL_VERSION` stays '2'.

### Features
- board projections: the read-board subscribe `view` field
  ('full' | 'sessions'), the `view` echo and `taskCountsByColumnId` on the
  snapshot response, and an optional `backlog` (7e9b8986)

  Additive in both directions: a pre-0.9.0 phone sends no `view` and gets
  the old payload verbatim; a 0.9.0 phone against a pre-0.9.0 desktop gets a
  full board with no `view` echo, which is exactly how it knows the snapshot
  was not filtered.
- pairing: the sealed pairing-confirm frame (`pairing/confirm.ts`,
  `sealPairingConfirm` / `openPairingConfirm`) and key fingerprints
  (`roster/fingerprint.ts`, `formatKeyFingerprint`) (2ca5832a)

## [protocol-v0.8.0] - 2026-07-24

All additive; wire `PROTOCOL_VERSION` stays '2'.

### Features
- the read-stream subscribe `terminal` flag, so a subscriber can opt out of
  the PTY stream (a5a2c241)

  `event:terminal` streamed continuously to a phone showing no terminal at
  all (~13MB/hour), because every subscription carried PTY bytes the phone
  discards by design at its own terminal boundary.
- the `message-preview` activity payload: the one line a phone's session
  list renders (cc1ec5f6)
- optional `since` (epoch ms the session first needed the user) on
  `ActivityReasonWire`'s idle and permission variants (a187cbdd)
- `pairing/relay-address.ts`: a dependency-free leaf carrying
  `MAX_RELAY_ADDRESS_LENGTH` and `isSecureRelayAddress`, so the desktop's
  relay validator cannot drift from the phone's and the renderer bundle does
  not pull in the rest of the package's @noble/* crypto (8c608c1e)

### Fixes
- `get_activity_intervals` is classified as a mobile board-tool read
  (eed683d8)

## [protocol-v0.7.0] - 2026-07-20

### Breaking Changes
- five-category push taxonomy + wake-channel seam (5d4a67eb)

  `PUSH_CATEGORIES` is now exactly `input-required`, `turn-complete`,
  `session-failed`, `plan-complete`, `spawn-stalled`, replacing the prior
  four (`permission-needed`, `agent-question`, `idle`, `agent-crash`).
  `input-required` merges the old `permission-needed` and `agent-question`
  categories into one, sourced from A2A Protocol's `TaskState.INPUT_REQUIRED`
  / MCP's `input_required` rather than Claude-specific naming.
  `RegisterPushRequestPayload` gains an optional `categories` field so a
  device can register only the categories it wants pushed.

## [protocol-v0.6.0] - 2026-07-20

All additive; wire `PROTOCOL_VERSION` stays '2'.

### Features
- prompt option labels, so the phone can label a pending prompt's answer
  buttons instead of answering blind: `awaitedPromptOptions?: string[] | null`
  on the read-stream subscribe snapshot, and `options?: string[]` on the
  activity event's permission variant (4e126bd3)

  Both carry the prompt dialog's numbered labels in keystroke order
  (options[0] is answered with "1\r"). Absent or null means unknown, and the
  phone falls back to its blind approve/deny keystrokes.
- optional `showTicketNumbers` on the read-board snapshot, so the phone's
  task cards follow the desktop's Layout setting instead of guessing; absent
  means true, the desktop default (67c56254)

## [protocol-v0.5.0] - 2026-07-16

All additive; wire `PROTOCOL_VERSION` stays '2'. Includes everything since
protocol-v0.3.0 (the 0.4.0 terminal-geometry work shipped unpublished).

### Features
- terminal dimensions on the wire: `TerminalDimensionsWire`, optional
  `ptyDimensions` on the read-stream snapshot, the `terminal-resize` event,
  and the `interactive-terminal` action union (write / resize / release-size)
- session lifecycle: `session-ended` activity payload variant and optional
  `sessionStatus` on `ReadStreamResponsePayload`
- E2E push: the `register-push` capability verb, `RegisterPushRequestPayload`
  / `RegisterPushResponsePayload`, and `crypto/push-envelope.ts`
  (XChaCha20-Poly1305 sealed notification envelopes, AAD-bound to the
  recipient device key, with staleness bounds)
- project accents: optional `color` on `ReadBoardProjectSummary` and
  `projectColor` on the board snapshot

### Fixes
- `terminal-resize` accepted by the envelope decoder's event validator
  (`validateEvent`), not only `isBridgeEvent`

## [protocol-v0.3.0] - 2026-07-14

### Features
- chunked delta transcript streaming, windowed history, and compression
  (68afad59)

## [protocol-v0.2.0] - 2026-07-13

### Features
- typed feed payloads, board-tool tuples, and read-stream gap fixes
  (b7accca6)
- Phase 2 capability handlers, data feeds, and the board-tool surface
  (8bfa87d1)

## [protocol-v0.1.1] - 2026-07-10

### Features
- add protocol package, device pairing, and secure relay transport (f5c97b9d)
