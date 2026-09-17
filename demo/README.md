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
npm run demo:serve                    # serve dist/demo/ and stay up for a manual look
npm run capture                       # build, then one still per scene and theme (and the marketing
                                      # video and walkthrough), into a gitignored captures/<timestamp>/
```

`demo:serve` prints a board URL. The one to open for a look is `stage.html`, the fixed-size host a
direct visit lands on; `?view=` picks the scene and the rest of the URL contract is below.

```
http://127.0.0.1:<port>/demo/stage.html                       the board, framed at 1600x1000
http://127.0.0.1:<port>/demo/?view=monitor&embed=1&stage=0    the Agent Monitor, edge to edge
http://127.0.0.1:<port>/demo/?view=board&still=1&stage=0      no clock, what a capture shoots
```

This is NOT `/preview`. That launches the Electron desktop app against its own scratch board and
serves none of this; the web build is a separate artifact and needs a static server.

**A dataset change is not finished until the captures are re-run.** The web demo rebuilds itself on
every release (`deploy-demo.yml`), and the marketing PNGs do not: no workflow runs `npm run capture`.
The scene stills are shot FROM the built demo (`tests/captures/features/scenes.capture.ts` opens
each registry scene by URL and screenshots it), so they cannot describe a state the live embed does
not, but a PNG someone copied into the site stays as old as the day it was shot. The hover video
(`agent-orchestration.capture.ts`) is now the only capture that seeds the dev server with
`marketing-fixture.ts` (the walkthrough builds its own state), and
`tests/unit/demo-dataset-consumer-parity.test.ts` keeps that seed and the build's in step; retire
the video and that fixture has no consumer left. Nothing can know when a PNG was last shot.

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
the one every terminal recording was made at, so at the stage the byte stream replays into the
very grid it was recorded for and the windows and the panel sit where the recordings were made
against. A host that sizes the iframe itself, like the site, passes `embed=1` and gets the frame
edge to edge; its terminals still replay exactly, held at their recording's grid and scaled to
fit (see Live replay below).

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
| `view` | any scene in `scenes.json` whose `reach` is not `driver` | A named scene from the registry. Default `board` unless `state=` is given. |
| `state` | base64url JSON of a `DemoState` | Declarative state merged over the scene, or standalone. Data only, never code. |
| `theme` | `kangentic-light`, `kangentic-dark`, `night`, or any app theme id | The two Kangentic ids are the product palette, built from the site's own `tokens.css`, so a page can embed the frame in either and stay branded. `night` is an alias for the app's dark theme (its no-class default), and `kangentic` is an alias for `kangentic-light`. |
| `embed` | `1` | Hides the OS window controls and renders edge to edge, for a host that sizes the iframe itself. Onboarding, update, and announcement toasts are already silent. |
| `stage` | `0` | Opened directly (no `embed`), the page hands over to `stage.html`, which hosts the frame at the site's 1600 by 1000, centered and scaled down when the window is smaller, so every terminal recording plays at the size it was made for. `stage=0` renders edge to edge in whatever window there is; the smoke tier uses it at a 1600 by 1000 viewport. |
| `still` | `1` | Zero animation and transition durations, the activity marks stop, the two ticking clocks freeze, no timer runs, and every terminal paints its recording's final frame. Without it each terminal replays its recording as it happened (see Live replay below). |
| `loop` | `1` | A working session that reaches its recording's end goes back to working and replays it, so a frame left running keeps moving. Off by default, because a hero or a docs figure must not reset state under a visitor who has taken control. Refused together with `still=1`, which has no replay to loop. |
| `fs` | `8` to `32` | Root font size for the UI and the terminal font size, in pixels. |

On success the frame stamps `data-demo-ready="1"` and `data-demo-scene` on `<html>` and posts
`{ type: 'kangentic-demo-ready', scene, version, focus }` to its parent; a page fades the frame in
on that message. Ready fires only once the scene's `ready` element exists (a restored task window
mounts a beat after the swimlanes, and a page lifting its poster on the message must not see the
board without the window the caption describes). `focus` is the rect of the scene's `focus`
element as fractions of the frame (`{ x, y, w, h }`), or null when the scene names none: a dialog
scene is small inside a 1600 by 1000 frame scaled into a docs column, and the rect is what lets the
page crop to the dialog without knowing the layout. It is posted once, at ready, and that is
enough: the frame is a fixed 1600 by 1000 inside the iframe whatever the host does, so the
fractions stay valid across a resize or a zoom and the host re-derives pixels from its own iframe
size. There is no follow-up message to listen for. An unknown scene, a rig-only scene, or a
malformed `state=` renders a full-frame error card, logs the reason, posts
`{ type: 'kangentic-demo-error', reason }`, and seeds nothing: a page can never caption a scene
the visitor is not looking at.

A `DemoState` (also the shape of every registry entry) is:

```ts
{
  config?: Record<string, unknown>;     // merged into window.__mockConfigOverrides; nested objects replace whole
  tasks?: Array<{ id: string } & Record<string, unknown>>;   // patches merged by id into the sample install's rows
  sessions?: Record<string, { activity?: 'thinking' | 'idle' | 'permission' }>;
  seeds?: Record<`__mock${string}`, unknown>;   // window globals the mock reads (diffs, branch summary, ...)
  steps?: Array<                                        // played before the reveal, in order
    | { click: string; waitFor?: string }               // a selector to click
    | { type: string; text: string; waitFor?: string }  // a field selector and the text set in it
    | { press: string; waitFor?: string }               // a hotkey in the registry's spelling, held
  >;
}
```

Example: open the Changes panel on a different file with no registry change.

```js
const state = { config: SCENES.task.config, tasks: [{ id: 'task-cw-middleware',
  detail_view_state: JSON.stringify({ changesOpen: true, changesScope: 'branch', changesSelectedFile: 'server/routes.ts' }) }] };
location.search = '?state=' + btoa(JSON.stringify(state)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') + '&embed=1&still=1';
```

## Scenes

`tests/captures/scenes.ts` is the registry, and it has two consumers: this build resolves
`view=<name>` through it, and the capture rig (`tests/captures/features/scenes.capture.ts`)
opens the same names in the built demo and screenshots them. A scene is how a docs figure scopes
to one section of the app, and it is DATA: config overrides, task-row patches, session activity,
`__mock*` seeds, and a short list of steps. Each entry carries a `reach`:

| reach | Meaning | Who can build it |
|---|---|---|
| `state` | config and rows alone; nothing is clicked | the web build and the rig |
| `boot` | state plus a few pre-reveal clicks | the web build and the rig |
| `driver` | needs a hover, a drag, or an open menu | the rig only; the web build refuses it |

Three fields leave this repo. `alt` is the reader-facing text a docs figure carries, authored
beside the state it describes (nobody else knows what the frame shows) and emitted into
`scenes.json` (below). `ready` is the selector that must exist before the frame counts as built:
the boot script waits for it before the reveal, the smoke tier asserts it visible for every
bootable entry, and the rig shoots after it. `focus`, when set, is the element whose rect rides
the ready message; name the box a reader would crop to, never an overlay's backdrop (the smoke
tier fails a focus that matches nothing, is empty, or is the whole frame). A scene may also say
`install: 'empty'`, which seeds no project at all (the
welcome screen). `tests/unit/scene-registry.test.ts` pins the rest: a `state` scene has no
steps, a `boot` scene carries only boot steps (a `click`, a `type` with `text`, or a `press` of a
hotkey in the registry's spelling, held for the frame, each with an optional `waitFor`), a
`driver` scene carries at least one rig step (`hover`, `contextmenu`, or `drag` with a `hold` that
leaves the pointer down), every patched task or session id is one the sample install seeds,
every config key is an `AppConfig` key, and the alt strings carry no dash or curly quote (the
writing-style scan excludes `tests/`). A boot step waits for its own target the way it waits for
`waitFor`: a restored window's panel mounts a beat after the board.

Adding a scene is one entry: the smoke tier boots it, the rig shoots it, and `scenes.json`
lists it, with no other file touched. What the catalog holds, and where each comes from:

| Scene | reach | Built from |
|---|---|---|
| `welcome` | state | `install: 'empty'`: no project seeded, the boot gate is the scene's own ready element |
| `board` | boot | one click on the panel tab for the working middleware session |
| `board-filter`, `activity-tab` | boot | one click each (the Filter button, the panel's Activity tab) |
| `announcements`, `announcement-dialog` | state, boot | `__mockActiveAnnouncements` seeded from the app's own `announcements.json` (dates dropped, `links` normalized); the dialog is one click on Learn more |
| `task`, `browser` | state | `workspaceByProject` (a floating window at 0.64 of the frame, a maximized one) and `detail_view_state.browserOpen`; the guest is the project's dev URL (Browser guest below) |
| `dictation` | boot | `config.dictation.enabled` and a held `press` of `Mouse:Back` (Dictation below) |
| `changes`, `changes-working`, `changes-staged`, `changes-history` | state | a maximized window plus `detail_view_state` (`changesScope`, `changesSelectedFile`, `changesViewedFiles`, `changesHistoryOpen`, `changesSelectedCommit`); the scopes, the graph, and the commit diff come from the seed (Git history below) |
| `changes-blame` | boot | the View options menu, then Show blame (blame is per-file view state, never persisted) |
| `monitor`, `monitor-table` | boot | one click; the layout is `config.monitor.layout`, which persists |
| `command-terminal` | boot | the title-bar toggle; the window's rect is the global `commandTerminalWorkspace` blob the scene seeds (the same 0.64 as the task window, for the same reason) |
| `usage`, `backlog`, `quick-find`, `new-task`, `edit-columns`, `completed-tasks` | boot | one click each; `usage` also sets `usageStatsScope` and `usageStatsPeriod` |
| `quick-find-results` | boot | the palette, then `type` a query; the seed answers with a keyword match over its own rows (Quick Find below) |
| `settings-<tab>`, one per tab in `settings-tabs.ts` | boot | the gear, then the tab button; generated from one tab-to-alt map the unit test pins to `SETTINGS_TABS` |
| `card-drag`, `card-menu`, `window-dock` | driver | a held drag over Executing, a right-click on a card, a window dragged to the right edge |

Three things the catalog corrected against the source while it was seeded, recorded so the next
reader does not re-derive them: `lastSettingsTab` is renderer store state and never reaches
config, so a settings tab is a click, not a config key; the Monitor's layout does persist
(`config.monitor.layout`) though its open flag does not; and `board` clicks, so it is `boot`.

Terminal type size is decided per scene by one rule: a terminal that is the SUBJECT of its
figure is at native type, and a terminal that is context beside a panel may be held. Every task
recording is 154 columns, and at the rig's launch (a real 2x scale, where the renderer rounds
the 12px Consolas cell to 6.5 CSS px) the window manager's default window (0.58 of the frame)
fits 142, so the seed holds the recording's grid at 0.92 of the type size. The floating scenes
(`task`, `dictation`, `window-dock`, `command-terminal`) therefore open their window at 0.64 of
the frame instead: 157 columns fit, the hold lands at 154 with the native cell (a held grid never
scales up), and the terminal reads at the size the board's bottom panel does. The Browser and
Changes scenes keep their terminal held (0.71 at the Browser split, 0.67 at the Changes split)
because the panel is the subject there, and the 0.65 of the width a native terminal needs
truncates the address bar and the note field, or clips a split diff mid-line. Below the seed's
0.6 floor the terminal would play frames at native type instead, which in a narrow pane wraps
the transcript mid-word and reads as broken, so the context terminal is never narrowed past it.

Two scenes are deliberately absent by that same rule. In a tiled figure the terminals ARE the
subject, and a half-width pane holds a 154-column recording at about two-thirds type, so
`windows-tiled` and `command-terminal-tiled` wait for a recording at the tiled width, the way
the Command Terminal boots already carry one (`terminal-<project>-tiled.json`); that is a
capture-matrix change, not a scene change. Also absent, needing dataset work the sample install
does not carry: the conversation viewer (no transcript is seeded). Two settings scenes render
empty lists on purpose and say so in their alts rather than being deferred: `settings-shortcuts`
(the sample install configures no project shortcuts, so the tab is its Add Shortcut and Presets
controls) and `settings-mobile` (no device is paired). Seeding either is a dataset decision, not
a bug in the scene.

### Quick Find

The desktop runs FTS5 in main over the tasks, the backlog, and the sessions' events. The seed
answers `search.everything` with a keyword match over the same rows it installed, scoped the way
the palette asks (this project or all), and builds the `task`, `backlog`, and `session_event`
hit shapes, so a visitor's query finds what the desktop's would and `quick-find-results` types
one. Conversation hits (the memory index) have no rows to search here and do not appear.

### Git history, blame, and the three scopes

`scripts/demo-repos/contoso-web` now carries `commits.json`, a commit plan (an author, and an
ordered list of commits naming the paths each adds; whatever is left lands in the last one).
`scripts/lib/demo-scaffold-repo.mjs` builds the scaffold as a real repository from it, with the
dates pinned and autocrlf off, so the hashes are the same on every machine; the capture matrix
records against that repo, and `node scripts/capture-demo-history.mjs` reads out of it, never
out of a hand-written list: the log in git:commitGraph's shape, the diff each commit introduces,
and `git blame` of every file a recorded session modified, run over the working tree that
session left behind (its recorded diff applied uncommitted), so the agent's own lines blame as
uncommitted the way they do on the desktop. The fixture is
`tests/captures/fixtures/demo/history/contoso-web.json`; re-run the script when the scaffold or
its plan changes. The seed serves it per worktree through `__mockCommitGraphByWorktree`,
`__mockBranchSummaryByWorktree`, `__mockBlameByWorktree`, `__mockFileHistoryByWorktree`, and
`__mockGitDiffByCommit`, matched on the worktree path the way the diff fixtures are. The two
upstream clones are shallow, with one commit of history; their History pane shows the empty
state a shallow clone would.

The three scopes of a recorded working tree are derived from the recorded statuses: a file the
agent ADDED is the staged set (an agent stages a new file with git add so it is tracked), the
files it MODIFIED are the working set, and Branch is everything against the base, which with
nothing committed on the task branch is the whole diff. A session that only edited existing
files has an empty Staged tab, as it would.

### Browser guest

No browser has Electron's `<webview>`, so `demo/webview-shim.js` is the mock of that one Electron
surface, the way `tests/ui/mock-electron-api.js` is the mock of the bridge: it watches for
`<webview>` elements, gives each an iframe and the method set the pane calls, and fires the
events the pane waits on as the iframe loads. The renderer is untouched (a custom element cannot
do this, since `webview` has no hyphen). What the iframe loads is `window.__demoGuestPages`,
built at build time from the sample install: a project's Browser default URL (`dev_url` on the
project, which the seed writes into its project config) maps to a bundled page under
`demo/guest/` that is what the project renders there (`guest_page`), so the address bar shows the
desktop's URL and the page shows the desktop's page. `demo/guest/contoso-web.html` is what
`scripts/demo-repos/contoso-web`'s `src/App.tsx` renders signed in as the store's admin user,
unstyled because the scaffold ships no stylesheet. Any other URL loads nothing. Inert: Inspect
(finds nothing), Draw capture (rejects), history (always empty), and the agent driving the pane.

### Dictation

`demo/boot.js` replaces `getUserMedia` with a silent stream from an audio graph, so a press of
the push-to-talk hotkey runs the renderer's whole pipeline with no permission prompt: the mock
grants the mic, starts a stub engine session, and the app's own audio worklet runs over silence.
The chip appears anchored to the target terminal in its live state, which is what `dictation`
shows. The words themselves land in the terminal on release (the popup experience), drawn by
the CLI's own echo of what main typed into the PTY, and no mock can draw that; so nothing is
transcribed and nothing authored ships. A visitor who presses the button sees the chip and,
on release, nothing typed, which is the one place the frame is quieter than the desktop.

### scenes.json, the hand-off to the site

The build emits `scenes.json` UNHASHED at the root, beside `index.html` and `stage.html`:

```json
{ "version": "0.41.0", "frame": { "width": 1600, "height": 1000 },
  "scenes": [ { "name": "board", "reach": "boot", "alt": "...", "description": "..." }, ... ] }
```

Generated from the same `SCENES` the page boots, so the two cannot drift; the smoke tier asserts
it is served, lists exactly the registry's names, and names the version the frame reports. It is
what a docs page reads: the site fetches it from the deployed demo at build time, validates every
figure's scene name (an unknown name or a `driver` scene fails the site build rather than
rendering the error card inside a captioned figure), and takes `alt` and `version` from it. A URL
cannot lag the way a vendored package does, which is the failure `@kangentic/branding` plus
`scripts/sync-brand.mjs` is known for. Placing frames on pages is the site's job (kangentic.com
#78 and #79); this file and the registry are the whole app-side contract.

### One viewport, one scale

Every scene is authored at one viewport, the 1600 by 1000 frame `scenes.json` names, at the
app's default type size, and the smoke tier boots every one of them at exactly that size. The
registry carries no per-scene size on purpose: a reader scrolling a docs page should meet the same
app at the same apparent size in every figure, only a different part of it, and a catalog that let
one scene pick its own viewport would break that the first time someone used it. The site has
full authority over how a figure is sized and cropped, within three rules that keep the frames
consistent with each other:

- **Never display a frame larger than 1600 CSS pixels wide.** The renderer's text scales as
  vectors, so a frame shown smaller than its viewport is as crisp as the app itself at any device
  pixel ratio. A terminal, though, is a canvas: xterm paints it as a bitmap at the frame's own
  size, and any upscale blurs it.
- **One display scale for the whole docs site, never per figure.** A dialog scene cropped to its
  dialog and shown at 1x beside a board scene shown whole at 0.45x is two different apps to the
  eye. Pick the scale once, from the figure slot's width, and apply it to every scene. The `focus`
  rect is for choosing WHERE a figure looks (a crop, a highlight ring), never for choosing how big
  it renders; a figure that crops to `focus` still renders at the site-wide scale, so it shows
  less of the frame rather than a bigger frame.
- **Readable means expandable, not rescaled.** At a 720px docs column the whole frame is 0.45x
  and its 12px type is 5px, which is a thumbnail, not a figure. Do not answer that by rendering
  different scenes at different scales. Either widen the figure slot (a full-bleed figure at 1000px
  or more reads at 0.6x and above) or keep the column and give every figure the same
  click-to-expand to 1:1, which the landing page's demo dialog already does for the hero. `fs=`
  can raise the app's type size, but it changes the layout too (fewer columns fit, the sidebar
  takes more of the width), so if the site uses it, it uses one value everywhere; the alts were
  written at the default.

This is also why the catalog has no tiled-window scene and why the floating scenes open a wider
window than the default (Scenes above): a terminal that is the subject of its figure is at the
same type size as every other frame's, and a tiled terminal cannot be until it has a recording
at the tiled width. A held terminal's exact scale also moves a little with the reader's device
pixel ratio, because the renderer rounds the cell to device pixels; the column counts above are
what the rig's launch measures.

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

### The agent's message trail

Card Preview defaults to `agent-latest-message`, so a default install prints the agent's newest
message on each board card where the description used to be, and the Monitor does the same. That
text is not in the terminal bytes in any recoverable form: the stream carries TUI chrome, and
parsing prose back out of it is the fragile path this whole file exists to avoid. It comes from
the agent's own transcript, which is what main reads (`src/main/agent/message-trail-tracker.ts`).

Each recording therefore carries a `messageTrail`: every prose-bearing assistant message, collapsed
to one plain line, on the stream's own clock. The derivation
(`tests/captures/helpers/message-trail-extract.ts`) imports main's per-agent transcript parsers and
its `assistantMessagePreviews`, so a change to what counts as decoration reaches the demo and the
desktop together. `capturedAt` is the END of a capture, so a line's offset is
`entryTs - (capturedAt - durationMs)`, the same clock `peekTimeline` uses. The seed puts the lines
already played into `messageTrailCache` before the renderer mounts, because `syncSessions`
reconciles the store against the `getMessageTrails()` snapshot and a push-only seed would be
dropped; the rest ride `scheduleSessionClock` beside the peeks.

Eleven of the sixteen sessions carry one. The other five show a description, exactly as they would
on the desktop: Cursor and Copilot have no transcript parser at all, a Command Terminal's session is
transient and `MessageTrailTracker` skips those, and the Gemini capture put all its prose in
thinking blocks, which `assistantMessagePreviews` excludes. A card with a trail draws it INSTEAD of
the output peek on the Monitor, because `MonitorBody` drops such a session from the wanted peek set,
so the peek machinery above now shows only for the sessions with no trail.

Backfilling this is NOT reproducible the way the timelines are. The transcripts live on the machine
that made the recordings, so the derived lines are committed into the recording files,
`node scripts/backfill-demo-message-trails.mjs` is a one-time rescue for what is already on disk,
and `tests/unit/demo-message-trail-seeded.test.ts` asserts the trails are PRESENT rather than
recomputing them. Going forward the capture script derives one per run; a transient session's
capture is told not to (`--no-message-trail`), since the matrix driver is what knows which those are.

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
was measured and not re-recordable until Codex credits return, and the Gemini session is still
at the rig's 120 by 40 until its quota allows a re-run. Neither matters to the replay any more:
a terminal is held at its recording's grid whatever that grid is (Live replay below), so a
37-row Codex boot in a 39-row window and the 120-column Gemini session both stream their bytes,
at a font a little smaller than the window's own fit. A boot wider than its window would still
be a real miss on the desktop, where an inline TUI's repaint lands on wrapped rows and the frame
ends up blank, which is why the matrix records at the surface's size rather than relying on the
hold.

The grid a visitor's terminal mounts with is theirs, not the recording's. The bottom panel is 15
rows tall, and the task window fits 154 by 37 only at the 1600 by 1000 frame with the sample
install's Consolas at a device pixel ratio of 1: the site's take-control dialog on a 1440 by 900
display fits 118 by 26, a Windows display scaled to 125 percent fits 144 by 36, and a machine
without Consolas measures another font. A recording's bytes address rows for its own grid
(Windows ConPTY re-emits even Claude's classic renderer with absolute cursor positions), so
replayed into any other grid they land two frames' text on one row. Main applies one rule to
that on the desktop, and the frame applies the same: bytes replay only into a terminal whose
grid equals the recording's.

So the terminal is brought to the recording's grid wherever the pane can show it. The seed
answers a replayed session's resize the way main answers one it refuses: with the grid it holds
(`SessionResizeResult.held`, here the recording's), and the terminal conforms to it, resizing to
that grid and scaling its font to fit the pane, letterboxed (`conformToHeldGrid` in
`useTerminal`). The picture is then the recording's, exact, at whatever size the host gave the
frame and on any display: the dialog at 1440 by 900 shows the 154-column session at about
9 px type. Whether to hold is decided by the scale the pane would need (`HOLD_MIN_SCALE` in
the seed's resize wrapper, 0.6): below it the type would be unreadable, so the terminal keeps
its own grid and plays frames instead. The bottom panel is that case, 15 rows against a
recording's 37 or 39. The conform only ever scales DOWN (`CONFORM_MAX_SCALE` in `useTerminal`
is 1): a pane larger than the held grid needs, a 2560 by 1440 display say, shows it at the
configured size and letterboxes the rest, so a held terminal is never in bigger type than the
panel beside it. Two font sizes on one screen was the first thing a live look caught. A held terminal keeps probing with the grid
it would fit on its own, so a Command Terminal that tiles still switches to the boot recorded at
the tiled width, and the desktop's own hold (a phone streaming the session) ends the moment
main accepts the probe. A real window resize repaints; the terminal reporting the grid it was
just held at does not, being the conform landing rather than the window moving. Reading that
report as a resize repaints on every conform, which put a whole frame into a terminal whose
session was already at its recording's end and should have received nothing.

A terminal that keeps its own grid plays the recording's FRAMES instead of its bytes, which is
what keeps the panel live. Every recording carries a `frameTimeline` beside its stream, the
screen every 250 ms with unchanged screens dropped, derived from the bytes already on disk. A
frame is PHYSICAL rows (`scripts/lib/demo-frame-serializer.js`): one row per recorded row, each
self-contained in its styling, joined with line breaks, behind the alternate-screen switch when
the CLI was on it, and ending in one absolute cursor position. It is not the serialize addon's
output, which joins a row onto the row before it wherever the terminal had wrapped and relies on
the same width to wrap it again: on a grid 20 columns wider every continuation spilled its first
20 characters onto the row above and started its own row 20 characters in, which read as a cut
left edge and a phantom sidebar (task #673). The final frame and the open frame are serialized
the same way, so an idle session on the frames path scrolls through its whole history.

The alternative was recording each surface at its own grid, and it does not work. The panel is 15
rows against a recording's 37, and no font size reconciles them: 154 columns needs about 16 px
type, at which 37 rows would want a panel taller than the whole frame. A grid also moves with the
display scale (the panel is 219 columns at 100 percent and 202 at 200), so a per-surface recording
would fit one machine and no other. Frames have neither problem and cost no capture run.

A geometry change also does not END the session. It does not finish an agent's turn on the
desktop, where main routes that session to its parsed frame and the agent goes on working, so it
must not here: a session the board shows as working keeps the clock the seed started, along with
its card, its sidebar count and its Monitor peeks. Only a session already at its end paints its
end.

The applier (`fitFrameToGrid` in `demo-dataset.ts`) fits each frame to the mounted grid row by
row, and the serializer already dropped the plain spaces ConPTY pads every row with. A row wider
than the grid is CUT at the edge, never left to wrap: the CLI would have re-laid its prose out at
this width, and a wrap mid-word is what nothing would draw. Before the cut, a cursor-forward gap
ahead of a right-aligned tail is shrunk so the tail lands at the edge (Claude's "/rc" at the
footer's edge, Copilot's timing beside its border). A row narrower than the grid whose last glyph
is a HORIZONTAL rule is extended with that glyph, so rules reach the edge the way the desktop
drew them; the bottom panel is 219 columns against a recording's 154, and without this a quarter
of it read as empty. Only horizontal glyphs: a vertical border extended sideways is a stripe,
which is what the striped block in #673 was (Copilot's right border, grown 20 wide by a rule
that stretched any box-drawing glyph). Gaps are never grown either, because a box border
followed by a one-cell gap and a sentence would put the sentence at the right margin. Widths are
counted in cells from the app's own Unicode 11 table, inlined into the seed at build time
(`buildCellWidthTable`), and autowrap is off while the rows are written, so a cell the two still
disagree on overwrites the last column instead of wrapping. The cursor is recomputed for the
mounted row count: a 37-row frame in the 15-row panel scrolls 22 rows up, and the cursor's row
moves with them. Prose keeps its recorded wrap points, because the CLI chose them at that width
and wrote them into the bytes as line breaks; only the CLI could re-wrap that, which is why the
task window is held at the recording's grid rather than fitted.

One thing the frame path does not do is make text bigger on a display scaled to 200 percent.
That report (kangentic.com #76) came from a capture at an emulated device pixel ratio of 2, and
it is the capture, not the frame: under Playwright's `deviceScaleFactor` the `device-pixel-content-box`
a `ResizeObserver` reports is the CSS size, and xterm's WebGL addon, which trusts that observer
for its canvas backing store, draws 2x glyphs into a 1x buffer. A real 2x display reports real
device pixels. A 2x poster is captured with WebGL off (`chromium.launch({ args: ['--disable-webgl'] })`),
which puts every terminal on the DOM renderer at the right size.

## What the page ships, and what it costs

Measured with `npm run demo:measure` on the build of 2026-09-17, headless Chromium, a plain
static server on localhost, warm disk.

### Before first paint (gzipped)

| File | Raw | Gzip |
|---|---|---|
| index (the renderer) | 1802 KB | 499 KB |
| xterm | 452 KB | 116 KB |
| demo-seed.js (the sample install: opening and final frames, diffs, peek timelines, message trails, the cell-width table) | 670 KB | 112 KB |
| mock-electron-api.js (the bridge) | 210 KB | 47 KB |
| react-vendor | 185 KB | 57 KB |
| index.css + xterm.css | 113 KB | 19 KB |
| Pill + datetime chunks | 87 KB | 29 KB |
| demo-boot.js + demo-scenes.js | 24 KB | 8 KB |
| **Eager total** | | **887 KB** |

The whole `dist/demo/assets` is 16.7 MB raw, almost all of it monaco's lazy language and worker
chunks, which only load when a Changes panel opens (the `changes` scene adds 4 requests).
`demo-seed.js` carries each session's terminal frame and the working-tree diff it left behind;
it is the one eager file that grows with the dataset (112 KB gzipped for 16 sessions and 10
diffs). It grew 14 KB gzipped when working sessions gained their opening frame as well as their
last one, which is what lets a still and the captures show the moment the live replay starts
from. It grew 3 KB more when they gained their peek timelines, which is what makes the Monitor
move without a terminal open. It grew 7 KB more for the agent message trails, which are what the
board cards themselves say under the default Card Preview. It grew 4 KB more when the frames
became physical rows and the seed took on the cell-width table the applier clips with.
The 36 recordings under `recordings/` are 36.1 MB raw and 868 KB gzipped
in total, fetched one at a time as terminals mount, so none of it is on the boot path. Each
carries its timed stream and its frame timeline, and the frames are roughly half that weight: they
are what keeps a terminal live where no grid can be held, which is the bottom panel. The largest
single file is the Gemini owner-search session at 114 KB gzipped.

### Cold boot per scene

| Scene | Requests | Off-origin | First contentful paint | Ready |
|---|---|---|---|---|
| board | 15 | 0 | 260 ms | 323 ms |
| task | 13 | 0 | 236 ms | 356 ms |
| changes | 17 | 0 | 268 ms | 410 ms |
| monitor | 14 | 0 | (paint inside the veil) | 293 ms |

Zero off-origin requests on every scene: the renderer's Sentry SDK has no network path of its
own and never initializes under the mock, analytics go through the bridge the mock stubs, and the
build references nothing outside its own origin. The `demo` smoke tier asserts this on every run,
so the site's privacy page needs no line for the frame.

### Frames per page

| Frames | All ready | Script time | JS heap |
|---|---|---|---|
| 1 | 319 ms | 185 ms | 15 MB |
| 4 | 767 ms | 395 ms | 33 MB |
| 8 | 1271 ms | 665 ms | 65 MB |

The bundle downloads once and caches; each frame parses and executes it again for roughly 70 ms of
script and 5 to 10 MB of heap. Eight live frames on one docs page cost about 1.3 seconds on a
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
| Task-detail Browser pane | The pane is the real renderer; its `<webview>` is stood in for by `demo/webview-shim.js`, an iframe onto a bundled copy of what the project renders at its dev URL (Browser guest below). Inspect finds nothing, capture rejects, and history is empty. |
| Folder pill, PR links, external links | Inert: `shell.openPath` and `openExternal` are logged by the mock. |
| Pop-out (Monitor, Changes, Stats) | Inert: the in-app surface stays where it is. |
| Dictation | The whole renderer pipeline runs on a press, over a silent microphone `demo/boot.js` supplies (the mic is never requested), and the chip shows its live state. The words land in the terminal on release as the CLI's echo, which cannot be shown (Dictation below). |
| Updater | Silent: no update is ever "downloaded". |

Two things stay out of reach of a live frame: the Browser pane's REAL guest (a page the agent is driving) and a dictated transcript landing in the terminal.

## Observations for the docs-visuals decision (#632)

- **Declarative reach, verified against the static build.** Everything reachable from config or
  a row in the desktop app is reachable here with no driver: `workspaceByProject` restores a
  task window (and stamps `skipEnterAnimation`, so it paints flat), `detail_view_state` opens the
  Changes panel on a tab and a file, `monitorWorkspace` and `commandTerminalWorkspace` restore
  their layouts once their surfaces open. Three corrections to the list #632 derived from source: the
  Monitor's OPEN state is not persisted (only its view settings and its inner windows), the
  Command Terminal layer's open state is component state, so both need one click, and
  `lastSettingsTab` is renderer store state that never reaches config, so a settings tab is a
  second click after the gear. Extension: the usage dashboard, the backlog view, Quick Find, and
  settings are all reachable by one click too.
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
index.html                       the entry, five classic scripts then the module bundle
stage.html                       the fixed-size host a direct visit lands on
scenes.json                      the scene list the site reads at build time: name, reach, alt, version
demo-scenes-<hash>.js            the registry, the app version, the recordings index, the guest pages
demo-boot-<hash>.js              demo/boot.js verbatim
demo-webview-<hash>.js           demo/webview-shim.js verbatim: the iframe standing in for <webview>
mock-electron-api-<hash>.js      tests/ui/mock-electron-api.js verbatim
demo-seed-<hash>.js              the sample install, final frames, diffs, and history embedded
recordings/<name>-<hash>.json    one timed stream per recording, fetched when a terminal mounts
guest/<name>-<hash>.html         what a project renders at its dev URL, for the Browser pane
assets/                          the renderer's hashed chunks and stylesheets, monaco's lazy chunks and workers
```

Every file but the two entry pages and `scenes.json` carries the first eight hex digits of its
content's SHA-256, the way Vite names its own chunks. GitHub Pages serves everything with a ten-minute cache, and a
visitor who opens the page across a release must never pair a new seed with an old recording:
a recording replays only into the grid its seed describes, and a stale one lands two frames'
text on one row. With the hash in the name a changed file is a new URL, an unchanged one is
still cached, and `index.html` is the only file whose cached copy can lag, for ten minutes, as a
whole and self-consistent page.
