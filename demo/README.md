# The web build

The desktop renderer built for a plain browser, so kangentic.com and the docs can embed the actual
app, live and clickable, instead of a screenshot or a hand-built silhouette. It is the same
`src/renderer` bundle the Electron app ships, running against the in-browser mock of the bridge
(`tests/ui/mock-electron-api.js`) and seeded with a sample install of three projects.

Kangentic stays a desktop app. Nothing here changes how it runs locally.

## Commands

On Windows, pass `--base` from PowerShell, not Git Bash: the MSYS shell rewrites
`--base=/kangentic/` into a `C:/Program Files/Git/...` path before node sees it, and
`scripts/build-demo.js` refuses a base that does not start with a slash for exactly that reason
(`MSYS_NO_PATHCONV=1` is the Git Bash escape hatch).

```
npm run build:demo                    # dist/demo/, base path /demo/
npm run build:demo -- --base=/kangentic/   # what the GitHub Pages deploy runs
npm run test:demo                     # the demo smoke tier against dist/demo/
npm run demo:measure                  # bundle weight, boot timings, frames-per-page cost
npm run demo:measure -- --serve       # serve dist/demo/ and stay up for a manual look
```

`scripts/build-demo.js` pins `NODE_ENV=production` before Vite starts; a bare
`vite build --config demo/vite.config.mts` from a shell that exports `development` is refused,
because Vite would otherwise ship React's development build and every `import.meta.env.DEV` branch
while exiting 0 (measured: the react-vendor chunk doubled to 383 KB).

## Where it runs

`.github/workflows/deploy-demo.yml` builds and deploys `dist/demo/` to GitHub Pages. The release
workflow calls it after `publish-release`, so the web build always shows the shipped app; a
`workflow_dispatch` redeploys any ref by hand. The page lives at
`https://kangentic.github.io/kangentic/` and the site and docs embed it as an iframe:

```html
<iframe src="https://kangentic.github.io/kangentic/?embed=1&still=1&view=board"
        width="1600" height="1000" inert></iframe>
```

Opened directly (a docs link, a review), the page hands over to `stage.html`, which hosts the
same frame at 1600 by 1000, centered, and scaled down when the window is smaller. That size is
not cosmetic: every terminal recording was made at the size of the surface it plays on, and a
replay cannot follow a window the way a live PTY does, so a wider window would unwrap lines a
CLI painted around and a narrower one would wrap them (see Live replay below). A host that
sizes the iframe itself, like the site, passes `embed=1` and gets the frame edge to edge.

Two one-time repository settings, both manual because the default token cannot make them:

1. Settings, Pages, Source: GitHub Actions. Until then `configure-pages` fails the deploy job,
   loudly, on every release.
2. The auto-created `github-pages` environment limits deployments to the default branch. Add a
   deployment branch rule for `v*` tags, or the tag-driven deploy is refused.

Adding the `demo` CI job to the required checks is a third, optional setting.

## The URL contract

All parameters are optional; `demo/boot.js` reads them once, before the mock loads.

| Parameter | Values | Effect |
|---|---|---|
| `view` | `board`, `task`, `changes`, `monitor` | A named scene from the registry. Default `board` unless `state=` is given. |
| `state` | base64url JSON of a `DemoState` | Declarative state merged over the scene, or standalone. Data only, never code. |
| `theme` | `kangentic-light`, `kangentic-dark`, `night`, or any app theme id | The two Kangentic ids are the product palette, built from the site's own `tokens.css`, so a page can embed the frame in either and stay branded. `night` is an alias for the app's dark theme (its no-class default), and `kangentic` is an alias for `kangentic-light`. |
| `embed` | `1` | Hides the OS window controls and renders edge to edge, for a host that sizes the iframe itself. Onboarding, update, and announcement toasts are already silent. |
| `stage` | `0` | Opened directly (no `embed`), the page hands over to `stage.html`, which hosts the frame at the site's 1600 by 1000, centered and scaled down when the window is smaller, so every terminal recording plays at the size it was made for. `stage=0` renders edge to edge in whatever window there is; the smoke tier uses it at a 1600 by 1000 viewport. |
| `still` | `1` | Zero animation and transition durations, the activity marks stop, the two ticking clocks freeze, no timer runs, and every terminal paints its recording's final frame. Without it each terminal replays its recording as it happened (see Live replay below). |
| `loop` | `1` | A working session that reaches its recording's end goes back to working and replays it, so a frame left running keeps moving. Off by default, because a hero or a docs figure must not reset state under a visitor who has taken control. Refused together with `still=1`, which has no replay to loop. |
| `fs` | `8` to `32` | Root font size for the UI and the terminal font size, in pixels. |

On success the frame stamps `data-demo-ready="1"` and `data-demo-scene` on `<html>` and posts
`{ type: 'kangentic-demo-ready', scene, version }` to its parent; a page fades the frame in on
that message. An unknown scene, a rig-only scene, or a malformed `state=` renders a full-frame
error card, logs the reason, posts `{ type: 'kangentic-demo-error', reason }`, and seeds nothing:
a page can never caption a scene the visitor is not looking at.

A `DemoState` (also the shape of every registry entry) is:

```ts
{
  config?: Record<string, unknown>;     // merged into window.__mockConfigOverrides; nested objects replace whole
  tasks?: Array<{ id: string } & Record<string, unknown>>;   // patches merged by id into the sample install's rows
  sessions?: Record<string, { activity?: 'thinking' | 'idle' | 'permission' }>;
  seeds?: Record<`__mock${string}`, unknown>;   // window globals the mock reads (diffs, branch summary, ...)
  steps?: Array<{ click: string; waitFor?: string }>;   // synthetic clicks before the reveal
}
```

Example: open the Changes panel on a different file with no registry change.

```js
const state = { config: SCENES.task.config, tasks: [{ id: 'task-cw-middleware',
  detail_view_state: JSON.stringify({ changesOpen: true, changesScope: 'branch', changesSelectedFile: 'server/routes.ts' }) }] };
location.search = '?state=' + btoa(JSON.stringify(state)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') + '&embed=1&still=1';
```

## Scenes

`tests/captures/scenes.ts` is the registry; the capture rig (#632) reads the same file. Each
entry carries a `reach`:

| reach | Meaning | Who can build it |
|---|---|---|
| `state` | config and rows alone; nothing is clicked | the web build and the rig |
| `boot` | state plus a few pre-reveal clicks | the web build and the rig |
| `driver` | needs a hover, a drag, or an open menu | the rig only; the web build refuses it |

Adding a scene is one entry. `board`, `task`, and `changes` are `state`; `monitor` is `boot`
(one click on the monitor button, since the Monitor has no persisted open flag).

## The sample install

`tests/captures/helpers/demo-dataset.ts`, shared by the marketing captures and the web build. Three
projects in two groups, chosen on GitHub star and fork data and avoiding the placeholder stable
(Acme and its Microsoft siblings, Initech and friends), with Contoso kept because developers in
the Microsoft world know it.

The two groups are named the way a sidebar actually gets named, and deliberately not in the same
shape as each other: one after the client, one as a category. Real people mix those. "Contoso"
says WHY its project is grouped, which "Work" did not, and "Open source" keeps two recognizable
repos from being labelled as leftovers, which is what "Other projects" would do to them.

| Group | Project | Stack | Default agent | Why |
|---|---|---|---|---|
| Contoso | `contoso-web` | React + TypeScript, Express API | Claude Code | The board the fixture always had, and the one a visitor lands on; two of its tasks run on Copilot CLI and Cursor, so the default board shows per-task agent choice rather than one model everywhere |
| Open source | `spring-petclinic` | Java, Spring | Codex CLI | The most-forked sample on GitHub (30.5k forks, since 2013); one session runs on Gemini CLI |
| Open source | `online-boutique` | Go, Kubernetes, gRPC | Codex CLI | The cloud-native reference app (20.9k stars, pushed this month) |

Across the three boards the agents are the five people actually use: Claude Code, Codex CLI,
Gemini CLI, Cursor, and Copilot CLI, plus OpenCode. A card's model name is not a label anyone
chose: it is what that session's agent reports, so the two cannot disagree. The default board
therefore reads Opus 5 on the Claude tasks, GPT-5.6 Luna on the Copilot one, and Claude Sonnet 4.5
on the Cursor one.

Cursor and Gemini are the two that need care. Both run a session through a router and print that
router ("Auto") in their own status line, but Kangentic never shows a router: it reads the model
the router RESOLVED to, from Cursor's init event and Gemini's session history. So their cards name
a model, as every other card does, and a card reading "Auto" would be a missing value rather than
a model. The two chosen fit the context windows their sessions declare, a million each:
`gemini-3-flash` is the Flash tier in `resolveGeminiContextWindowSize` where Pro is two million,
and `claude-4.5-sonnet` with its display string are exactly as `cursor-agent --list-models` prints
them. Note that spelling is Sonnet-first; the older word order in the app's `CURSOR_COMMON_MODELS`
fallback is stale.

Every timestamp is an offset from boot, so cards read "3 min ago" whenever the frame opens.
Sessions cover every state the app distinguishes (thinking, needs-you, a permission prompt,
suspended, queued) plus a Command Terminal; Monitor rows are derived from the session rows so the
two views cannot disagree; the usage dashboard is a seeded, deterministic fourteen-day series.

### Terminal recordings

Every terminal in the sample install is a recording of a real session; there is no hand-authored
terminal content, and the build refuses to seed a session that has none.
`tests/captures/fixtures/demo/manifest.json` lists one recording per session: which agent, which
repo, the prompt, and for a session the app shows as working, either the second at which the
recording is cut (`stopAfter`, `stopWhen`), so its last frame is the spinner and the tool calls
in flight, or no cut, so the recording runs to the agent's own end and the live frame shows it
finish (Live replay below). `scripts/capture-demo-sessions.mjs` runs the matrix through
`scripts/capture-agent-scrollback.js`: a real PTY, the prompt in argv the way Kangentic launches
every adapter, trust pre-seeded the way Kangentic does, the recording stopped at the cut or when
the output goes quiet, the session ended with the adapter's exit sequence and the same grace a
young agent gets in the app. The raw bytes are replayed through the headless xterm parser and the
terminal state is serialized to a plain stream, which is what the frame replays: a full-screen
TUI only reproduces at the geometry it was recorded at, the serialization renders at any size.
Only the serialized stream is kept, with the raw byte count beside it: the raw stream holds every
wrapped fragment of every path the agent ever printed, and a recording is a tenth of the size
without it.

Each recording also carries the working tree the agent left behind (`changes`, in the shape
`git.diffFiles` returns), and the dataset seeds it per task through the mock's
`__mockGitDiffByWorktree`, so the Changes panel of any recorded task shows the real diff next to
the real terminal. The `changes` scene selects `server/routes.ts` from the middleware session's
diff. A session cut while the agent was still reading has an empty diff, which is what the app
would show too. The one recording without a `changes` field is the Gemini session, made before
the rig captured diffs and not repeatable until its quota resets; re-run it with
`--only gemini` to fill it in. The Monitor's output peek is each recording's own last displayed
lines (`peek`, read from the rendered headless terminal at record time, with each CLI's footer
and status chrome skipped), never authored; the concurrency cap is set to the number of running
sessions, so the one queued spawn is waiting on a genuinely full set of slots.

The sample install is a Windows machine, because the recording machine is one and so is the
mock's platform: the OS window controls, the Git Bash chip, the agents' PowerShell tool calls,
their backslash paths, and the home directory all agree. Sanitization at record time changes
only the identity: the user becomes `dev`, the home `C:\Users\dev`, the scratch clone the
project's real path under it (`C:\Users\dev\work\contoso-web`), the host name goes, each of them
also when a row wrap or an escape sequence interrupts the literal, and the write is refused if a
marker survives; `tests/unit/demo-fixtures-sanitized.test.ts` is the CI backstop. Re-run the
matrix when an agent's TUI changes:

```
node scripts/capture-demo-sessions.mjs --skip-existing   # only missing recordings
node scripts/capture-demo-sessions.mjs --only codex      # one agent
```

The scratch clones land under the recording user's home directory at the paths the sample
install gives them (`~\work\contoso-web`, `~\oss\spring-petclinic`, `~\oss\online-boutique`),
on purpose: every CLI prints its working directory somewhere, the full-screen ones truncated to a
status-bar column, and a truncated path can only survive sanitization when the part that
survives is already the final text. `--root` moves them at the cost of that property.

Each CLI must be logged in; the runs happen on the accounts of whoever runs the matrix. The set
was recorded with Claude Code, Codex CLI, Gemini CLI, OpenCode, and GitHub Copilot CLI. What kept
the others out, so the next run knows what to expect: Kimi Code and Droid had no account on the
recording machine, and a login screen is not a session; Cursor CLI stopped at its own
workspace-trust prompt, which the capture rig cannot answer and which has no config file to
pre-seed; Qwen Code's configured endpoint rejected the first request; Gemini's free API-key tier
ran out of quota after one session, so the other two Gemini sessions moved to OpenCode and Codex;
Codex bills API credits on the recording machine and ran out of them after the second full
matrix, so the petclinic Spring Boot 3.5 review task runs on Claude, pinned on the task.
Codex runs in bypass mode (the adapter's
`--dangerously-bypass-approvals-and-sandbox`) because its Windows sandbox needs a helper the
recording machine does not have, and a session in which every file read fails is not worth
showing. It also runs with its startup update check off (`-c check_for_update_on_startup=false`,
the one flag the rig adds to an adapter's launch shape): started with no prompt, an outdated
Codex parks on its "Update available" modal for the whole boot, and a notice about the recording
machine's install is not part of any session being shown.

### Live replay, and what a visitor can start

Every recording carries the same bytes twice: the serialized final frame, which a still frame
and the marketing captures paint through the production mount-replay path, and a timed stream
(the bytes in 100 ms windows with their arrival times). The live frame replays the stream: a
session the app shows as working has everything but its last 90 seconds as scrollback when the
page opens and streams that stretch from there, a session shown idle or waiting on a prompt is
already at its end, and when a recording ends the terminal stays on its last frame. A recording
that ran to the agent's own end (the manifest entry has no cut, so the capture stopped on idle or
exit) carries that in its `stopReason`, and when the replay gets there the session flips from
working to needs-you, as main's activity engine does when a turn completes: the card's ring, the
sidebar count, and the Monitor row all change. A recording cut short stays working on its last
frame. The clock runs from page open whether or not a terminal is mounted, so the card on the
board flips at the moment a window would show the answer land. How long before the end a
working session opens is the manifest's `liveTailMs` (90 seconds), or the session row's own
`liveTailMs` so that two agents do not finish on the same second. The capture script keeps the
frame at that moment beside the recording's end (`openFrame`, with the Monitor peek of that
moment), and a still frame and the marketing captures paint it for such a session, so every
view of the sample install starts from the same moment. The stream files sit under `recordings/` and are fetched from the same origin when a
terminal mounts, so a still frame and a first paint fetch nothing.

### The Monitor's output peek, and `loop=1`

A Monitor card shows the last lines its session's terminal is displaying, and on the desktop
those change as the agent works. That is most of what makes the Monitor read as live, and it has
to hold on a page where no terminal is open at all, so it cannot come from a mounted xterm. Each
recording therefore carries a `peekTimeline`: the displayed last lines and when they changed, on
the stream's own clock, so the frame schedules them against the clock it replays the bytes on.
The row changes whether or not a terminal is mounted, and a Monitor-only frame still fetches no
recording.

Raw, there is far too much of it. Two of the sample install's sessions change their last lines
six times a second, which reads as a flicker rather than as an agent working. So
`scripts/lib/demo-replay-timelines.js` samples the changes by READING TIME: a change is kept only
once the one before it has been on screen long enough to read, between 2.5 and 6 seconds
depending on how much text it carries. Real output varies in length, so the kept spacing comes
out irregular on its own. Nothing in it is random, which matters because the built files are
content-hashed and a build has to be reproducible. What each working session gets:

| Session | Recording | Changes kept in its live window |
|---|---|---|
| `sess-cw-api-client` | 207 s | 45 |
| `sess-cw-middleware` | 128 s | 26 |
| `sess-ob-otel` | 152 s | 25 |
| `sess-ob-currency-a11y` | 35 s | 12 |
| `sess-pc-flaky-tests` | 20 s | 5 |

Which sessions the board shows as WORKING is chosen for this, not at random, and a recording's
`stopReason` decides what it can honestly be. One cut mid-work (`stop-after`) ends on a spinner
with tool calls in flight, so it reads as working and cannot read as anything else. One that ran
to the agent's own end (`idle`) ends on an answer, so it can be either: shown as working it plays
its last stretch and then finishes, which is the transition `loop=1` cycles.

That is why the OpenTelemetry session carries the Codex slot. It is 152 seconds of real work with
25 changes, where the Redis TTL session it replaced was 21 seconds with 5, and looped those same
five lines over and over. Redis TTL now sits as needs-you, which its own last frame already showed:
a finished summary above an empty prompt.

`sess-pc-flaky-tests` stays short at 5. It was cut at 20 seconds, so raising the manifest's
`stopAfter` and re-recording is the fix, and that needs Codex credits (exhausted 2026-09-13). Its
terminal is live either way now that a frame timeline rides along, and `loop=1` cycles it. When a session's replay reaches the end it finishes as it always does, waits six
seconds so the state it finished in is readable, and starts the same stretch over. Each session
loops on its own clock, so the Monitor keeps changing rather than going quiet until the longest
recording comes round. A mounted terminal is repainted from the opening frame first (1.8 KB for
the middleware session, against the 151 KB its replay emits), so a frame left running for hours
does not grow a cycle of scrollback every time. A working session whose terminal mounted on a
grid the recording does not fit loops too, since its card and its Monitor row are the part that
moves; the restart emits nothing to that terminal, which is holding a parsed frame.

The marketing captures pass no timeline at all. The rig has no recordings index, so no clock ever
runs, and a peek that changed on a timer would make the PNGs different every run.

A recording made before either timeline existed gets both from
`node scripts/backfill-demo-timelines.mjs`, which derives them from the stream that is already on
disk. Same module as the capture script (`scripts/lib/demo-replay-timelines.js`), so a backfilled
recording and a fresh one agree; no agent, no API credit, and no re-record.

The main process is not in a browser, so what its transition engine would start is recorded
too, by `scripts/capture-demo-sessions.mjs` from the dataset rather than from a hand list:

- A card dragged into an auto-spawn column gets its agent started in that lane's permission mode,
  replaying the boot recorded for that task and mode (`spawn-<taskId>-<mode>.json`: the agent's
  header, the prompt Kangentic's default template sends, its first tool calls). A live session
  follows the card, as the engine's create-or-resume does; a paused one resumes on its own
  transcript and waits.
- A new Command Terminal boots the project's default agent with no prompt, which is what the
  desktop starts: `terminal-<projectId>.json` when its window opens alone,
  `terminal-<projectId>-tiled.json` when it opens beside the project's running terminal. When a
  window later tiles or stands alone again, the desktop's PTY resize has the CLI repaint; here
  the session switches to the boot recorded at the other width and repaints from a cleared
  screen at the same point in the boot.
- Each is announced through the pushes main sends (session status, activity, first output,
  usage, the Monitor snapshot), so the card, the Monitor, and the context bar react as they
  would to the real thing: the "Starting agent" veil lifts when the recording's first window
  would have arrived, the context bar's pills replace its spinner a beat later, when the
  desktop's status-line push would land, and the Monitor row's output peek is the recording's
  own last lines once the boot has played out.

Two boundaries, both stated rather than papered over: a task the visitor creates has no boot of
its own and gets the project's Command Terminal boot (the agent starting with nothing to do yet),
and nothing typed into a terminal reaches an agent, since there is none. A replay cannot
renegotiate the PTY size the way a live PTY does: a full-screen TUI (OpenCode, Copilot) only
reproduces at the size it was recorded at, and a row-based renderer (Claude Code's classic
renderer, Codex, Gemini) wraps and pads at its recorded width and height. So every recording is
made at the size of the surface it plays on, from the manifest's `geometry` (read from the mock's
resize calls at the 1600x1000 site frame): a task session at the task window (154 wide), the
Command Terminal session at its single window (154 wide), and a Command Terminal boot at both
sizes its window can open at (154 wide alone, 124 wide tiled beside an existing terminal), the
frame picking one at spawn time. The rows follow the agent, because the window's context bar
does: a Claude session's bar carries the account's rate-limit pills and wraps to two rows,
leaving 37, while every other agent's bar is one row, leaving 39 (`rowsByAgent` in the
manifest). The Codex task sessions and spawn boots are still at 37 rows, recorded before that
was measured and not re-recordable until Codex credits return, so they play as frames in their
39-row windows rather than streaming. A boot wider than its window is not a cosmetic miss: an inline
TUI's repaint lands on wrapped rows and the frame ends up blank. The one exception is the Gemini
session, still at the rig's 120 by 40 until its quota allows a re-run.

The grid a visitor's terminal mounts with is theirs, not the recording's. The bottom panel is 15
rows tall, and the task window fits 154 by 37 only with the sample install's Consolas at a device
pixel ratio of 1: a Windows display scaled to 125 percent fits 144 by 36, and a machine without
Consolas measures another font. A recording's bytes address rows for its own grid (Windows
ConPTY re-emits even Claude's classic renderer with absolute cursor positions), so replayed into
any other grid they land two frames' text on one row. Main applies one rule to that on the
desktop, and the frame applies the same: bytes replay only into a terminal whose grid equals the
recording's.

Any other grid plays the recording's FRAMES instead, which is what makes every surface live. A
frame reflows where a stream cannot, so the same recording paints correctly at any size: the
board's bottom panel shows the last 15 rows of a 37-row frame, which is what a terminal scrolled
to the bottom shows anyway, and a display scaled to 125 percent gets each frame fitted to its
width. Every recording therefore carries a `frameTimeline` beside its stream, the screen every
250 ms with unchanged screens dropped, derived from the bytes already on disk. Measured across
all four common Windows display scales, both the task window and the board's bottom panel now
stream; before this, the panel streamed at no scale and the task window at half of them.

The alternative was recording each surface at its own grid, and it does not work. The panel is 15
rows against a recording's 37, and no font size reconciles them: 154 columns needs about 16 px
type, at which 37 rows would want a panel taller than the whole frame. A grid also moves with the
display scale (the panel is 219 columns at 100 percent and 202 at 200), so a per-surface recording
would fit one machine and no other. Frames have neither problem and cost no capture run.

A geometry change also does not END the session. It does not finish an agent's turn on the
desktop, where main routes that session to its parsed frame and the agent goes on working, so it
must not here: a session the board shows as working keeps the clock the seed started, along with
its card, its sidebar count and its Monitor peeks. Only a session already at its end paints its
end. A frame is fitted before it is served: the build drops the
plain spaces ConPTY pads every row with (they wrap into blank rows on a narrower grid), and at
serve time the applier shrinks a right-aligned tail's cursor-forward gap to the mounted width
(Claude's "/rc" at the footer's edge) and cuts trailing rule glyphs and styled bands there, so
rows end where the CLI would have drawn them and the frame's cursor, placed relative to its
bottom row, lands on its row. A 1:1 display gets the byte stream, which is character by character
and the better picture; every other display gets the frame timeline, four repaints a second.

A grid WIDER than the recording is fitted too, but only so far. A CLI draws its rules and bands to
the width it was given, so on a wider grid they stop short and the frame reads as though it fills
only part of the terminal; the bottom panel is 219 columns against a recording's 154, so a quarter
of it looked empty. A rule is the one run that can honestly be stretched, and it is: extended with
its own glyph out to the mounted width, which is where the desktop's CLI would have drawn it.

Nothing else is. Prose keeps its recorded wrap points, because the CLI chose them at that width
and wrote them into the bytes as line breaks; only the CLI could re-wrap that. A cursor-forward gap
in particular is NEVER widened, even though it would push a right-aligned footer tag out to the
edge: the serializer emits one at every point it joined a wrapped row, so growing gaps shoves the
continuation of a sentence out to the right margin. That was tried and reverted on sight. The cost
is that a tag like Claude's "/rc" sits where the narrower grid put it. Every window opens
at the size its recording was made for, so only a deliberate resize reaches this. Stretching the
rules and the styled bands alone would look tidier and read worse: it would wrap the recorded
width's text inside a visibly wider box. The real fix is the one above, a bundled fixed-cell font
and a re-recorded matrix.

## What the page ships, and what it costs

Measured with `npm run demo:measure` on the build of 2026-09-12, headless Chromium, a plain
static server on localhost, warm disk.

### Before first paint (gzipped)

| File | Raw | Gzip |
|---|---|---|
| index (the renderer) | 1752 KB | 484 KB |
| xterm | 452 KB | 116 KB |
| demo-seed.js (the sample install: opening and final frames, diffs, peek timelines) | 631 KB | 101 KB |
| mock-electron-api.js (the bridge) | 200 KB | 45 KB |
| react-vendor | 185 KB | 57 KB |
| index.css + xterm.css | 110 KB | 18 KB |
| Pill + datetime chunks | 84 KB | 28 KB |
| demo-boot.js + demo-scenes.js | 21 KB | 7 KB |
| **Eager total** | | **857 KB** |

The whole `dist/demo/assets` is 16.2 MB raw, almost all of it monaco's lazy language and worker
chunks, which only load when a Changes panel opens (the `changes` scene adds 4 requests).
`demo-seed.js` carries each session's terminal frame and the working-tree diff it left behind;
it is the one eager file that grows with the dataset (101 KB gzipped for 16 sessions and 10
diffs). It grew 14 KB gzipped when working sessions gained their opening frame as well as their
last one, which is what lets a still and the captures show the moment the live replay starts
from, and 3 KB more when they gained their peek timelines, which is what makes the Monitor move
without a terminal open. The 36 recordings under `recordings/` are 35.6 MB raw and 886 KB gzipped
in total, fetched one at a time as terminals mount, so none of it is on the boot path. Each
carries its timed stream and its frame timeline, and the frames are roughly half that weight: they
are what makes a terminal live on a grid the bytes cannot address, which is every display scale
but two and the bottom panel at all of them. The largest single file is the Codex OpenTelemetry
session at 114 KB gzipped.

### Cold boot per scene

| Scene | Requests | Off-origin | First contentful paint | Ready |
|---|---|---|---|---|
| board | 13 | 0 | 132 ms | 306 ms |
| task | 13 | 0 | 248 ms | 379 ms |
| changes | 17 | 0 | 276 ms | 415 ms |
| monitor | 14 | 0 | (paint inside the veil) | 294 ms |

Zero off-origin requests on every scene: the renderer's Sentry SDK has no network path of its
own and never initializes under the mock, analytics go through the bridge the mock stubs, and the
build references nothing outside its own origin. The `demo` smoke tier asserts this on every run,
so the site's privacy page needs no line for the frame.

### Frames per page

| Frames | All ready | Script time | JS heap |
|---|---|---|---|
| 1 | 277 ms | 153 ms | 14 MB |
| 4 | 664 ms | 340 ms | 42 MB |
| 8 | 1210 ms | 632 ms | 76 MB |

The bundle downloads once and caches; each frame parses and executes it again for roughly 70 ms of
script and 5 to 10 MB of heap. Eight live frames on one docs page cost about 1.2 seconds on a
desktop machine, which is the number the docs-visuals decision (#632, site #78 and #79) was
waiting for. This does not decide live frames against stills; it says the ceiling is well above
what a docs page would use.

## Electron-only surfaces in a browser

Everything below was clicked in the served build; nothing throws, because the mock implements
every bridge method (`tests/unit/mock-electron-api-parity.test.ts` keeps that true).

| Surface | What happens in the frame |
|---|---|
| Usage dashboard | Renders fully from the seeded series (Recharts, lazy chunk). |
| Quick Find, settings, announcements, backlog view | Open and work; settings persist in the mock for the session. |
| Command Terminal | The window opens on the project's default agent booting, from its recording; typing into it reaches no process. |
| Drag into an auto-spawn column, Resume | The agent starts from the boot recorded for that task and mode, or resumes on its transcript (Live replay above). |
| Add project | The mock's folder dialog returns a fixed path; a fourth project appears in the sidebar. |
| Task-detail Browser pane | Shows the "Open a URL" empty state; there is no `<webview>` outside Electron. |
| Folder pill, PR links, external links | Inert: `shell.openPath` and `openExternal` are logged by the mock. |
| Pop-out (Monitor, Changes, Stats) | Inert: the in-app surface stays where it is. |
| Dictation | The mock reports a stub engine; the microphone is never requested unless the visitor starts dictation, and a cross-origin iframe without `allow="microphone"` denies it. |
| Updater | Silent: no update is ever "downloaded". |

The two things a docs page cannot show live are the Browser pane's guest and dictation.

## Observations for the docs-visuals decision (#632)

- **Declarative reach, verified against the static build.** Everything reachable from config or
  a row in the desktop app is reachable here with no driver: `workspaceByProject` restores a
  task window (and stamps `skipEnterAnimation`, so it paints flat), `detail_view_state` opens the
  Changes panel on a tab and a file, `monitorWorkspace` and `commandTerminalWorkspace` restore
  their layouts once their surfaces open. Two corrections to the list #632 derived from source: the
  Monitor's OPEN state is not persisted (only its view settings and its inner windows), and the
  Command Terminal layer's open state is component state, so both need one click. Extension: the
  usage dashboard, the backlog view, Quick Find, and settings are all reachable by one click too.
- **The boot-time scene builder is viable and stays small.** `steps` is a list of
  `{ click, waitFor }`; the runner is under forty lines of `demo/boot.js`, veils `#root` while it
  runs, and reveals on the last `waitFor`. It is deterministic because every step waits for a
  selector rather than a delay, and it ran 30 boots of the `monitor` scene in the smoke tier and
  measurement runs without a miss. It does not turn into a tour because it has no timing, no
  narration, and no way to express a hover or a drag; those stay `driver` scenes for the rig.
- **Per-frame boot cost** is in the table above: about 70 ms of script and under 10 MB per extra
  frame after the first, one second for eight.

## Layout of `dist/demo/`

```
index.html                       the entry, four classic scripts then the module bundle
stage.html                       the fixed-size host a direct visit lands on
demo-scenes-<hash>.js            the registry, the app version, the recordings index
demo-boot-<hash>.js              demo/boot.js verbatim
mock-electron-api-<hash>.js      tests/ui/mock-electron-api.js verbatim
demo-seed-<hash>.js              the sample install, final frames and diffs embedded
recordings/<name>-<hash>.json    one timed stream per recording, fetched when a terminal mounts
assets/                          the renderer's hashed chunks and stylesheets, monaco's lazy chunks and workers
```

Every file but the two entry pages carries the first eight hex digits of its content's SHA-256,
the way Vite names its own chunks. GitHub Pages serves everything with a ten-minute cache, and a
visitor who opens the page across a release must never pair a new seed with an old recording:
a recording replays only into the grid its seed describes, and a stale one lands two frames'
text on one row. With the hash in the name a changed file is a new URL, an unchanged one is
still cached, and `index.html` is the only file whose cached copy can lag, for ten minutes, as a
whole and self-consistent page.
