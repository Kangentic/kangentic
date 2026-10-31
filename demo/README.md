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
node demo/measure.mjs --heap          # the JS heap after a forced GC for the cases the site budgets
                                      # (--dist=pathA,labelB=pathB compares builds back to back, --runs=N,
                                      # --scenes=a,b, --dwell=ms)
node demo/measure.mjs --heap-snapshot=board,loop   # one frame's heap snapshot, summed by constructor;
                                      # two builds through --dist print what moved (--out=dir)
node demo/measure.mjs --geometry      # the grid each terminal surface fits, at device scale 1 and 2,
                                      # against the capture matrix's manifest (--check fails on a drift)
node demo/measure.mjs --motion        # every scene under loop=1, sampled for 16 s: moves, marks, or still
                                      # (--scenes=a,b measures only those)
npm run demo:serve                    # serve dist/demo/ and stay up for a manual look
npm run capture                       # build, then one still per scene and theme (and the marketing
                                      # video and walkthrough), into a gitignored captures/<timestamp>/
npm run demo:posters                  # build first; every scene in clay and rust at 2x, verified and
                                      # zipped with a manifest into dist/demo-posters-<version>.zip,
                                      # the release asset the site's docs figures read
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
The one set a workflow does shoot is the poster set (`npm run demo:posters`, driving only
`scenes.capture.ts`; see "The poster set" below), which `release.yml` attaches to every release, so
a docs figure's poster is as fresh as the release it names and never fresher. The scene stills are
shot FROM the built demo (`tests/captures/features/scenes.capture.ts` opens each registry scene by
URL and screenshots it), so they cannot describe a state the live embed does not, but a marketing
PNG someone copied into the site stays as old as the day it was shot. The hover video
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

A host that shows a `loop=1` frame owes the reader a visible way to stop it. WCAG 2.2.2 (Pause,
Stop, Hide) asks it of any motion that starts by itself, lasts more than five seconds, and sits
beside other content, and an `inert` frame takes no click, so the control lives on the page. The
frame's stopped state already exists: swap the frame's `loop=1` for `still=1` (or show its poster),
which is the scene's poster moment, deterministic, with nothing moving, and swap back to play. The
frame needs no message for it, and a pause that froze the frame in place would have to freeze every
session clock, the terminal replay, and the choreography together, which the frame does not offer.
A visitor whose system asks for reduced motion is covered either way: the page should start them
on `still=1`, and a `loop=1` frame holds its choreography at rest for them on its own.

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

## Browser extensions

A visitor's extensions run inside the frame. No web API turns them off, and a content script
ignores the page's CSP, so Grammarly once drew its button into the New Task description while
`new-task` typed. Electron runs no extensions, so all of this lives in `demo/boot.js` and none of
it in `src/renderer`.

Our own shots are clean by construction. Every capture, poster, measurement and demo-tier run is
Playwright's bundled Chromium, whose default switches include `--disable-extensions`.
`tests/unit/demo-launches-no-extensions.test.ts` fails on a launch under `demo/`, `tests/captures/`,
`tests/demo/` or `scripts/` that takes that back: a persistent context, a `channel` other than
`chromium`, a `--load-extension`, or an `ignoreDefaultArgs` that is `true` or names the switch. It
also reads the switch out of the installed `playwright-core`, so an upgrade that drops it fails
there. The `chromium` channel is the full Chromium build Playwright downloads beside the default
headless shell, run in Chrome's new headless mode with the same default switches. The host-scroll
tests run on it, because the headless shell stops a scroll at a fixed box that Chrome carries on
into the embedding page.

In a visitor's browser the frame does two things:

- **Each vendor's opt-out on every text field**, stamped as the field mounts and again on focus,
  before an extension attaches. These are Grammarly's `data-gramm`, `data-gramm_editor` and
  `data-enable-grammarly`, LanguageTool's `data-lt-active`, 1Password's `data-1p-ignore`,
  Bitwarden's `data-bwignore`, and Dashlane's `data-form-type="other"`, each the attribute its
  vendor documents for a site owner. LastPass documents none. `<html translate="no">` keeps a
  translate extension, or the browser's own translate, off the UI text.
- **A sweep for what has no opt-out**, so an extension nobody has tested is covered too. A content
  script runs in an isolated world, which leaves two marks. The world has no custom element
  registry, so the host element an extension adds (`grammarly-extension`, LanguageTool's `lt-*`)
  is a hyphenated tag the page never defined. And the world has its own DOM prototypes, so an
  element it appends under `<html>` or `<body>` never went through the page's `createElement`,
  which `boot.js` wraps as its first statement to record what the page makes. A marked element
  gets `data-demo-foreign` and a `display: none` rule. It is never removed, because an extension
  that sees its node go tends to add it again. The second signal starts at DOMContentLoaded, when
  the parser's own children are adopted as the page's.

The Browser pane's guest page is a document of its own and extensions inject there too, so
`demo/webview-shim.js` installs the same opt-outs and sweep each time it loads.

The demo tier holds both halves. Every scene boots, and every choreography plays a cycle, with
nothing marked: Playwright runs no extension, so a mark there would be the sweep hiding part of
the app. Another test runs a script in an isolated world over CDP, the way Chrome runs a content
script, in the New Task dialog and in the guest page. It checks that what that script adds is
hidden, that the page's own nodes in the same places are not, and that every text field carries
every opt-out.

Three gaps are known:

- An extension that runs its script in the page's own world (an MV3 `world: 'MAIN'` script)
  passes both signals. Only its own opt-out keeps it out.
- A plain element an extension appends under `<body>` before DOMContentLoaded is adopted as the
  page's. Extensions inject at document end or later, after that point, so this is rare.
- `stage.html` is not shielded. It holds no field and runs no `boot.js`.

The demo tier runs Chromium only. Firefox reaches the page through Xray wrappers, so check the
sweep there by hand, as you would a change to the choreography. A quick check in a browser with
Grammarly: the G button never shows while `new-task` types, and
`Boolean(document.querySelector('[data-gramm="false"]'))`, run in the frame's console, is `true`.

## Focus rings

Chromium outlines an element a script focuses (`:focus-visible`) unless the last input it saw was
a mouse, and it counts only trusted input. Every click a frame makes on its own, a boot step or a
choreography, is synthesized. So a dialog that focuses its first button on open drew a ring that the
same click on the desktop does not. Measured on the Language picker: a trusted pick leaves the
restart prompt's close button focused with no ring, and the synthesized pick ringed it, as
`board-config-change` ringed its dialog's close button. `demo/boot.js` therefore marks the page
`data-demo-untouched` and draws no focus outline under it. The mark goes at a visitor's first
trusted press or key, caught in the capture phase, so a first Tab already draws its ring, and from
then on Chromium decides. A text field keeps its outline, because Chromium matches it after a mouse
click too, so the outline a boot click into a field draws is the desktop's. Only the outline is
suppressed, since a `ring` utility is box-shadow, which a selected element can carry too.
`:focus-visible` still matches underneath, so nothing that reads it changes.

## The URL contract

All parameters are optional; `demo/boot.js` reads them once, before the mock loads.

| Parameter | Values | Effect |
|---|---|---|
| `view` | any scene in `scenes.json` | A named scene from the registry. Default `board` unless `state=` is given. |
| `state` | base64url JSON of a `DemoState` | Declarative state merged over the scene, or standalone. Data only, never code. |
| `theme` | `clay`, `rust`, `night`, or any app theme id | `clay` (light) and `rust` (dark) are the product palette, built from the site's own `tokens.css`, so a page can embed the frame in either and stay branded. `night` is an alias for the app's dark theme (its no-class default, labelled Graphite), `kangentic` is an alias for `clay`, and the pair's short-lived earlier ids `kangentic-light` / `kangentic-dark` still resolve to `clay` / `rust`. |
| `embed` | `1` | Hides the OS window controls and renders edge to edge, for a host that sizes the iframe itself. Onboarding, update, and announcement toasts are already silent. |
| `stage` | `0` | Opened directly (no `embed`), the page hands over to `stage.html`, which hosts the frame at the site's 1600 by 1000, centered and scaled down when the window is smaller, so every terminal recording plays at the size it was made for. `stage=0` renders edge to edge in whatever window there is; the smoke tier uses it at a 1600 by 1000 viewport. |
| `still` | `1` | Zero animation and transition durations, the activity marks stop, the two ticking clocks freeze, no timer runs, and every terminal paints its recording's final frame. Without it each terminal replays its recording as it happened (see Live replay below). |
| `loop` | `1` | A working session that reaches its recording's end goes back to working and replays it, and a scene's choreography plays by itself (Choreography and timelines below), so a frame left running keeps moving. Off by default, because a hero or a docs figure must not reset state under a visitor who has taken control. Refused together with `still=1`, which has no replay to loop. |
| `fs` | `8` to `32` | Root font size for the UI and the terminal font size, in pixels. |

On success the frame stamps `data-demo-ready="1"` and `data-demo-scene` on `<html>` and posts
`{ type: 'kangentic-demo-ready', scene, version, focus }` to its parent; a page fades the frame in
on that message. Ready fires only once the scene's `ready` element exists (a restored task window
mounts a beat after the swimlanes, and a page lifting its poster on the message must not see the
board without the window the caption describes). `focus` is the rect around the scene's `focus`
elements as fractions of the frame (`{ x, y, w, h }`), or null when the scene names none: a dialog
scene is small inside a 1600 by 1000 frame scaled into a docs column, and the rect is what lets the
page crop to the dialog without knowing the layout. It is posted once, at ready, and that is
enough: the frame is a fixed 1600 by 1000 inside the iframe whatever the host does, so the
fractions stay valid across a resize or a zoom and the host re-derives pixels from its own iframe
size. There is no follow-up message to listen for. An unknown scene or a malformed `state=`
renders a full-frame error card, logs the reason, posts
`{ type: 'kangentic-demo-error', reason }`, and seeds nothing: a page can never caption a scene
the visitor is not looking at.

One more message goes out, and it is the only one tied to a keystroke.
`{ type: 'kangentic-demo-escape', scene }` fires when an Escape keydown reaches the frame and the
app has nothing of its own to close, so a host showing the frame in a dialog can close it. A host
cannot do this itself: the frame is cross-origin, and the renderer's arrival-focus arbiter focuses
a mounted terminal exactly as it does on the desktop, so from then on every key goes to the
terminal's textarea and no listener on the parent page sees one. Nothing in `demo/` takes that
focus and nothing here declines it, because the renderer never branches on being embedded. Only a
visitor's own Escape posts: a key a script dispatched (a choreography's, or a boot step's press) is
untrusted, and the frame keeps it for the app.

What counts as "the app owns this Escape" is not invented here. `boot.js` mirrors the ladder in
`src/renderer/pop-out/PopOutWindowFrame.tsx`, which already answers the same question for a pop-out
window: a focused text field, an open `[data-dismissable-layer]`, an open window frame, or Monaco's
find widget each keep the key. Two differences, both deliberate. The listener is CAPTURE phase
where the pop-out's is bubble, because xterm can consume Escape inside its own key pipeline and a
bubble listener would never see the one case that matters; capture also reads the guards while an
overlay about to be dismissed is still in the DOM, which is the property the pop-out's own comment
relies on. And the xterm helper textarea is exempted from the focused-text-field guard, since it is
a textarea and it is precisely the case that must post.

A window owns the first Escape, as it does on the desktop: on the `task` and `windows-tiled`
scenes the visitor presses Escape twice, once to close the window and once to close the host's
dialog. That holds wherever the pointer is. On the desktop a task window's terminal keeps Escape
for the agent while the pointer is over it, and a card click leaves the pointer exactly there once
the window opens. Here the terminal replays a recording with no agent to interrupt, so `boot.js`
does what the desktop does with the pointer outside: the terminal never gets the key, and the
window closes through its own X.

Three kinds of open frame are no sign the app will act on the key, so none of them is claimed:

- The Command Terminal has no Escape of its own. Its layer hides on the panel-close combo, the
  toggle, or a backdrop click. On the `command-terminal` scenes the first Escape is posted and the
  window stays open.
- Any frame at all, when the key sits in a terminal outside a task window: the bottom panel's, or
  a Command Terminal's. xterm stops propagation of the Escape it handles, so the document listener
  a window closes on never sees it. A visitor reaches this by clicking into the panel's terminal,
  which light dismiss leaves the window open for.
- A parked or retained window. A task window closed with a live Browser guest stays mounted at
  zero opacity so the guest survives, and `WindowFrame` marks it `inert`. It has nothing left to
  close, so on the `browser` scene the second Escape is posted.

`tests/unit/scene-registry.test.ts` pins each marker `boot.js` looks for against the renderer file
that stamps it, including the hover test it mirrors from `terminal-clipboard.ts` and the `inert`
mark on a parked or retained window, so a rename fails there rather than quietly changing what the
site's figures do.

A `DemoState` (also the shape of every registry entry) is:

```ts
{
  config?: Record<string, unknown>;     // merged into window.__mockConfigOverrides; a nested block REPLACES the default
  tasks?: Array<{ id: string } & Record<string, unknown>>;   // patches merged by id into the sample install's rows
  sessions?: Record<string, {                   // patches on sessions the sample install seeds
    activity?: 'thinking' | 'idle' | 'permission';    // the session's activity state
    status?: 'running' | 'suspended' | 'queued';      // a paused or queued card
    resuming?: true;                                  // a running session respawned on relaunch, not yet printing
  }>;
  seeds?: Record<`__mock${string}`, unknown>;   // window globals the mock reads (diffs, branch summary, ...)
  steps?: Array<                                        // played before the reveal, in order
    | { click: string; waitFor?: string }               // a selector to click; a text field is focused first
    | { type: string; text: string; waitFor?: string }  // a field selector and the text set in it
    | { press: string; waitFor?: string }               // a hotkey in the registry's spelling, held
  >;
  rows?: string[];                              // scene-only tasks to add, each with its session (Scene-only rows below)
}
```

A registry entry may also carry `choreography`, `timeline`, and `motion` (Choreography and
timelines below). None of the three rides a `state=` blob, so a URL can never carry a tour.

A session patch is an input to the seed, not a pass over its output. `boot.js` publishes the
merged patches as `window.__demoSessionPatches` before the seed runs, and the seed folds each one
into its session before it derives anything from it: the row, the Monitor row, the usage, the
activity stats, and a working session's clock. Applied to the rows afterwards, as it once was, a
paused card's Monitor row still read working. `resuming` is the moment after a relaunch, when main
has respawned the agent on its own conversation and it has not printed yet: the seed holds the
session's usage back, so the card and the context bar read "Resuming agent..." rather than a
model. A still holds that moment. The live frame plays what main sends next, the same way a
visitor's Resume click does: first output a beat after page open, then the usage, which is when
the card trades "Resuming agent..." for its model. The flag itself stays set, as it does in main:
it means the session was spawned as a resume. `validateState` refuses a field outside these
three, a value outside its set, and a resume on a session it also stops.

`rows` is the same kind of input. It names tasks the sample install leaves out (`DEMO_SCENE_TASKS`
in `demo-dataset.ts`), and the seed adds each one with its session before the session patches are
folded, so a scene can patch one and everything derived from a row describes it. `boot.js`
refuses an id the build does not carry (the build emits the list as `window.__demoSceneRowIds`),
and writes each named row's own script into the page ahead of the seed (`window.__demoSceneRowScripts`,
Scene-only rows below).

A nested config block replaces the default rather than merging into it: the merge is a shallow
`Object.assign` here and again in the mock. So naming one field of `monitor` would leave the other
six undefined, on settings nothing in the frame shows, which is a figure that is quietly wrong
rather than one that fails. A partial block is therefore REFUSED with the missing fields named, in
a scene (`tests/unit/scene-registry.test.ts`) and in a `state=` URL (`validateState`, against the
shape the build emits as `window.__demoConfigShape`). Spell the block whole.

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
`__mock*` seeds, a short list of steps, and how it moves. Each entry carries a `reach`, which says
what the frame does before it reveals:

| reach | Meaning |
|---|---|
| `state` | config and rows alone; nothing is clicked |
| `boot` | state plus a few pre-reveal clicks, or a choreography's pose (a card held mid-drag, a menu open) |

The web build and the rig build every scene the same way, through `boot.js`. A held gesture (a
card mid-drag, a menu open) is a choreography whose pose the still plays (Choreography and
timelines below).

Three fields leave this repo. `alt` is the reader-facing text a docs figure carries, authored
beside the state it describes (nobody else knows what the frame shows) and emitted into
`scenes.json` (below). `ready` is the selector that must exist before the frame counts as built:
the boot script waits for it before the reveal, the smoke tier asserts it visible for every
bootable entry, and the rig shoots after it. `focus`, when set, is the element whose rect rides
the ready message; name the box a reader would crop to, never an overlay's backdrop (the smoke
tier fails a focus that matches nothing, is empty, or is the whole frame). A selector list
(`a, b`) names several elements and the rect is the box around all of them, which is how
`session-resume` crops to its two cards; the smoke tier fails a list whose selectors do not each
match exactly one element, so a single selector that starts matching a second one cannot quietly
widen a figure's crop. A scene may also say
`install: 'empty'`, which seeds no project at all (the
welcome screen). And it may say `settle`, a selector list of elements its subject places on
every animation frame, for a frame that keeps moving after `ready`: the rig and the smoke tier
shoot only once one of them is shown and none has moved for half a second (`waitForSettled` in
`tests/captures/helpers/scene-page.ts`). `boot.js` never reads it; a live frame plays the motion as
the desktop does. `tests/unit/scene-registry.test.ts` pins the rest: a `state` scene has no
steps and no pose, a `boot` scene carries only boot steps (a `click`, a `type` with `text`, or a
`press` of a hotkey in the registry's spelling, held for the frame, each with an optional
`waitFor`) or a pose, every patched task or session id is one the sample install seeds,
every config key is an `AppConfig` key, and the alt strings carry no dash or curly quote (the
writing-style scan excludes `tests/`). A boot step waits for its own target the way it waits for
`waitFor`: a restored window's panel mounts a beat after the board. A `press` of a mouse button
goes through `boot.js`'s `pressCombo` as one pointerdown, which `__demoBoot.pressCombo` exposes to
the contract tier. It presses one listed button: a chord the registry allows, or a button
`boot.js` does not list, fails the step with the combo's name.

Adding a scene is one entry: the smoke tier boots it, the rig shoots it, and `scenes.json`
lists it, with no other file touched. What the catalog holds, and where each comes from:

| Scene | reach | Built from |
|---|---|---|
| `welcome` | state | `install: 'empty'`: no project seeded, so the boot gate is the app having rendered at all. Under `loop=1` it opens Show setup, clicks Refresh (every row reads Checking for the app's own 800 ms), and closes the list again |
| `welcome-setup` | state | the same empty install plus `__mockAgentListOverrides`, one agent signed out and several not installed. No click: the screen opens its own setup list whenever anything is missing, which is what the seed produces. Under `loop=1` it clicks Refresh, the one control that puts every row through its check: each reads Checking for the app's own 800 ms and resolves to the same report |
| `board` | boot | one click on the panel tab for the working middleware session |
| `session-states` | boot | `sessions` patches: one session to `suspended` (a paused card in Planning), one to `queued` (Code Review). Both columns are in frame at 1600px, which Merge is not. Its `motion` is the panel's stream and the api-client flip; no cycle pauses a card to start the queued one, since the card has no pause control, the sample install's cap leaves a slot free, and a resume mints a new session |
| `session-resume` | boot | `sessions` patches: the Planning WebSocket session `resuming` and `idle` (a resumed agent starts idle and keeps its trail), the card below it `suspended`. `focus` names both cards, so the rect is the box around the pair. Show it as a still or its poster: live, the resume resolves about 1.5 seconds after page open, as the desktop's does, and only once. No choreography cycles it: the card has no pause control (the task window does), and a demo resume starts a session under a new id |
| `activity-overlay` | state | `config.developer.activityDebugOverlay`; the snapshot each panel draws is derived from that session's own seeded events by `activityStatsFor` (Activity stats below). Live, the snapshot follows the session clock: main takes it when the overlay asks, so the time since a session's last signal counts up between polls, and a session the clock flips turns idle with the engine's `event:idle` step logged (`event:prompt` when `loop=1` starts it again). A still keeps the snapshot the seed built |
| `notification-toast` | state | `__mockInitialExit`, fired once when `sessions.onExit` registers, so App.tsx raises the toast itself; `notifications.toasts.durationSeconds` holds it up. Its `motion` is that toast's countdown line filling and the board's own idle toasts as its sessions finish on their clocks; raising the exit toast again would take a push main never sends twice. A still pauses the line where it starts: in still mode `boot.js` freezes the one Web Animation under `toast-countdown`, since its clock would otherwise put a different fill in each shot, and leaves every other Web Animation running (dnd-kit's drop animation has to finish for a held card to let go) |
| `board-config-change` | state | `__mockBoardConfigChanged`, fired once when `boardConfig.onChanged` registers, which App.tsx turns into its own reconciliation dialog. Under `loop=1` the always-apply box is ticked, and the frame cuts and unticks it behind the veil; neither Apply nor Dismiss is pressed, and raising the dialog again would take a file change that never happened |
| `edit-columns`, `column-automation`, `column-automation-turn-end`, `column-handoff` | boot | the column's edit button (and, for `column-handoff`, the All columns tab), plus one shared `__mockSwimlanePatches` ladder (`COLUMN_LADDER` in `scenes.ts`) so the four describe one board: Claude Code plans on Opus 5 at xhigh and builds on Sonnet 5, Codex CLI reviews in an isolated session, Claude tests, and GitHub Copilot CLI merges, with handoff on at each change of agent. `column-automation`, `column-automation-turn-end` and `column-handoff` add the Code Review automation through `__mockAutomations`; `edit-columns` keeps the enter and exit slots empty. Never the dataset: an automation draws a glyph in the BOARD column header, so seeding one there would change every figure already placed. The forms show Model and Effort because the sample install reports each agent's capabilities (`DEMO_AGENT_OVERRIDES`), and Codex has no Effort field because it takes none from Kangentic. Codex also reports no turn end, which the dataset's agent list carries from its adapter, so Code Review's On agent turn end reads blocked as it does on the desktop. That is why `column-automation-turn-end` puts the review loop on Testing, where the ladder hands the review on to Claude. It holds two Move to column rows the runner reads in order, one of each Condition kind so both row marks show: back to Executing on an Agent evaluation (the robot mark) with a Frequency of three and a Message carrying `{{agentReply}}`, then on to Merge, once, on a Text match (the text search mark) of the line `PR: ready to merge`, the gate this repo's own `kangentic.json` puts on Testing. A move ends the group, so when the first row fires the second never runs. Under `loop=1` every edit is a draft and Save is never pressed: `edit-columns` selects Testing, drags it above Code Review (Save lights up) and rests the pointer on Save, then the frame cuts, and behind it Testing goes back below Code Review (Save goes dark) and Code Review is selected again; `column-automation` adds an automation on task exit, picks Notify, and cancels the draft row away; `column-handoff` opens Testing from the table, which is read-only, switches its handoff off, and shows the draft in All columns, then the frame cuts and the switch goes back on behind it; `column-automation-turn-end` opens each turn-end row in its Edit automation dialog and cancels it |
| `column-automation-edit` | boot | the same board and rows as `column-automation-turn-end`, Testing's edit button, then the first turn-end row's edit button, so the Edit automation dialog shows Send findings back as its four cards: Trigger, Condition, Frequency and Action. The first row, because its Condition is an Agent evaluation in plain words where the second quotes one specific final line. It also seeds `config.automation` (Claude on Sonnet 5), since with no Automation agent the Condition card shows its setup notice in place of the condition, and the sample install chooses none. No menu is left open, so it boots in a frame. At 1600 by 1000 the dialog is about 115px taller than its body allows, so the body scrolls: the first three cards show whole, and the Action card shows its Type, its column and the Message, whose last line (`{{agentReply}}`) is cut off at the bottom of the body, with the Template variable picker below the fold. The dialog keeps the app's own size and type. Under `loop=1` its choreography picks Text match, types the reviewer's last line for it, takes the Frequency down to one, and rests the pointer on Done; then the frame cuts, and behind it the line is cleared, the Frequency goes back to three, and Agent evaluation is picked again. The dialog keeps the evaluation's text across the switch, so the cycle ends on the poster's values, and Done is never pressed |
| `workflows` | boot | `__mockWorkflows` and `__mockWorkflowLinks` plus `tasks` patches that join six existing contoso cards to one running workflow (Workflows below); the Workflows toggle, the agent pane's collapse, Board, Workflows again, then a click on empty canvas. It also seeds `config.automation`, since a workflow step needs an Automation agent to judge it. Under `loop=1` a card is dragged up into empty canvas and Auto layout slides it home (the button turns itself off once no card is hand-placed), and when the middleware session's recorded turn ends (about 90 s in) its timeline does what main does: the step is done at the route's last column, Executing, so the card moves to Done, and with its one blocker done the engine starts Add user auth flow in Planning, which plays its recorded plan-mode boot. The restart six seconds later undoes both |
| `board-workflow` | state | the same seed, on the board: each member card's strip and step track, the To Do cards' waiting line, and the toggle's running mark. It carries the same timeline and `config.automation` as `workflows`, so live, about 90 s in, the middleware card leaves Executing for Done and Add user auth flow moves into Planning and starts its agent. Under `loop=1` the pointer rests on Refactor API error handling and then on Add user auth flow, so the board draws each one's workflow links in turn, and leaves the board |
| `workflow-draft` | boot | a second `__mockWorkflows` seed, a workflow planned but not started (its tasks live in the draft, so nothing reaches the board), read from the plan its recorded agent saved, and `config.workflows` naming Claude, so the agent pane opens on that recording's end (Workflow agent below); the view, then a click that selects the billing page task, so the inspector shows its route switches and the route task it waits for. Under `loop=1` the pointer goes over the agent's reply, selects the server route task and then the billing page again, and switches off the billing page's Planning stop, the column the recorded reply offers to skip; then the frame cuts and Planning goes back on behind it. Start is never pressed |
| `board-filter`, `activity-tab` | boot | one click each (the Filter button, the panel's Activity tab). Under `loop=1` `board-filter` turns on High priority and the feature label, each narrowing the board behind it, and the frame cuts and turns them off behind the veil; `activity-tab` narrows the list to the middleware session's events, to api-client's, and back to All with its filter. The events are seeded once: no recording carries tool events to put on its clock, and the transcripts that would carry them are not committed |
| `announcements`, `announcement-dialog` | state, boot | `__mockActiveAnnouncements` seeded from the app's own `announcements.json` (dates dropped, `links` normalized); the dialog is one click on Learn more. Under `loop=1` the pointer goes over the banner's controls and the megaphone, and over the dialog's links and QR code, each showing its hover; nothing is pressed, since dismissing or opening the feed marks the announcement read and a link opens a browser |
| `task`, `browser` | state | `workspaceByProject` (a floating window sized to its session's recording, a maximized one) and `detail_view_state.browserOpen`; the guest is the project's dev URL (Browser guest below). `browser` patches the middleware session idle, so its terminal rests on the frame its recorded Send starts from. Under `loop=1` it types that recording's note into the pane's own field and presses Send: the recording plays on (the payload pasted and echoed whole, the screenshot read, the agent working), and a few seconds in the frame cuts and the seed takes the Send back behind the veil (Live replay below) |
| `task-mcp` | state | `rows` adds the scene-only Validate request bodies task (Scene-only rows below), and `workspaceByProject` restores its window maximized. Its session is the MCP recording (An agent calling Kangentic's MCP tools below), working, with a `liveTailMs` cut to that recording: a still paints the moment `kangentic_get_current_task`, `kangentic_list_columns` and `kangentic_list_automations` have printed their results, and live, the agent then reads Testing with `kangentic_get_column_detail` and moves the card with `kangentic_move_task`, about eleven seconds that `loop=1` replays. The whole `terminal` block is spelled out with a larger font, the one exception to the type rule above (One viewport, one scale). It also seeds `__mockAgentListOverrides` with the dataset's agent list and Claude Code at 2.1.302, the version the recording ran on, so the context bar and the terminal's header agree. Its `timeline` moves the card to Testing when the recording ends, which is where the move's result lands (the manifest's `stopWhen` cut it there), through the push main sends for an agent's move; `loop=1` puts the card back in Code Review as the stretch starts over. The session stays: on this board Testing names the same agent, changes no model or effort, and sends no column message, which is `handleTaskMove`'s keep-alive case for a live session (Priority 3 in `task-move.ts`). The capture's preview did spawn there, because the recorded agent ran in the rig's own terminal, so the preview's task had no live session to keep |
| `windows-tiled` | state | `workspaceByProject` with two `tiled` windows under one horizontal split, in the footprint a dock produces; both sessions have a recording at the tiled width (Terminal recordings below) |
| `conversation` | state | `workspaceByProject` with one `conversation` window anchored on the middleware session id; the transcript is the one recorded beside the session (Transcripts below). Under `loop=1` a search is typed and its matches stepped through, then the frame cuts, and behind it the search is cleared and the viewer's own Jump to latest brings the closing message back |
| `dictation` | boot | `config.dictation.enabled` and a held `press` of `Mouse:Back` (Dictation below) |
| `dictation-field` | boot | the same config, the gear and the Dictation tab, and a `click` on the Settings search box (which focuses it); then a choreography whose pose is the held `Mouse:Back`, so the chip anchors under a text field instead of a terminal, over the empty box (Dictation below). Live, the held key hears the recorded utterance, its partials typed into the box as they stream. Under `loop=1` it lets the key go, the refined "Push to talk." lands and the tab narrows to the rows it names, then the cut clears the box and the press plays again |
| `changes`, `changes-working`, `changes-staged`, `changes-history` | state | a maximized window plus `detail_view_state` (`changesScope`, `changesSelectedFile`, `changesViewedFiles`, `changesSelectedCommit`; History is open by default, so no key opens it); the scopes, the graph, and the commit diff come from the seed (Git history below). Under `loop=1` `changes` opens the new middleware file, routes.ts again, and marks routes.ts viewed, then the frame cuts and the mark comes off behind it; `changes-working` looks at the Staged tab and comes back to Working, `changes-staged` looks at Working and comes back to Staged, and `changes-history` hovers the rate limiting commit, then opens the routes commit's other file and routes.ts again, staying on the routes commit so the cycle ends on the poster. Its `ready` is the selection bar's subject, which a restored selection takes from the commits History loads |
| `changes-blame` | boot | the View options menu, then Show blame (blame is per-file view state, never persisted) |
| `monitor`, `monitor-table` | boot | one click; the layout is `config.monitor.layout`, which persists. Under `loop=1` `monitor` types a filter that narrows its cards and regroups them by status, then the frame cuts, and behind it the grouping goes back to project and the filter is cleared. A card with a message trail draws the trail, never its output peek, so tighter peek sampling would move almost nothing here; the cycle is what moves the page between the agents' messages. `monitor-table` clicks its Column header through ascending, descending, and back to unsorted, each step waiting on the header's `aria-sort`, which only the sorted header carries |
| `command-terminal` | boot | a choreography whose pose is the open window: the pointer rests on the title-bar toggle, whose tip shows the Command Terminal shortcut, then clicks it. The panel's rect is the global `commandTerminalPanel` the scene seeds, fitted so the terminal beside the rail is as wide as the terminal session's recording, like the task window. Under `loop=1` the panel is maximized, then the cut restores it and hides the layer (its session keeps running), so the frame fades in on the board and the open plays again. Its session finished its recording, and the scene has no opening frame to restart it from |
| `command-terminal-tiled` | boot | a choreography whose pose is the pair: the toggle after the pointer rests on it for its tip, then the rail's Add terminal after a short rest. Add terminal docks a second window beside the first and boots the project's default agent from the boot recorded at the tiled width; the first switches to its own tiled recording as it narrows. Under `loop=1` the pointer looks at the second window's model pill, then the cut stops that terminal (its slot comes free, so the next Add terminal takes slot-2 again, and the seed ends its replay and Monitor row with it) and hides the layer, and the open plays again |
| `usage`, `backlog`, `quick-find`, `new-task`, `completed-tasks` | boot | one click each; `usage` also sets `usageStatsScope` and `usageStatsPeriod`. Under `loop=1` `usage` switches to Today, This Month, and back to This Week; `backlog` selects two items and opens the bulk Move to board menu with the pointer on a column, never picking one (a column would promote them for real), then the frame cuts, and behind it the menu closes and the selection clears; `new-task` types a title and a description, sets the priority, picks the feature label from the suggestions, and rests the pointer on Create, then the frame cuts and the form is put back behind it, Create never pressed; `quick-find` types a query a key at a time, then the frame cuts and clears it behind the veil; `completed-tasks` opens the CI/CD pipeline row's completed task view, closes it, and opens the list again from the Completed header, which sits past the frame's right edge, so the board scrolls to it and back |
| `completed-task`, `completed-task-usage` | boot | the Completed header, View details on the Set up CI/CD pipeline row, and the window's maximize toggle (floating, the window cuts each tab off after its first cards); `completed-task-usage` then clicks Usage. Both seed `__mockTaskReports` with that task's whole report (One whole report below), and `__mockTaskChanges` with main's answer for its commits (not in this clone, since they are authored), so `ready` names a card only that report draws: the Route on Summary, the ledger's Models and tokens on Usage. Under `loop=1` each steps through the three tabs the report fills (Summary, Usage, Description) back to its own, passing over Changes and Conversation, which have nothing recorded behind them |
| `knowledge-graph` | boot | the title-bar button, then the Projects picker, All, and the picker again to close its menu (the open flag and the scope are store state); the map is the one main's pipeline built over the recorded conversations, and the rig waits for it to `settle` (Knowledge Graph below). Under `loop=1` it drags one orbit around the map and one over it, then Reset view flies the camera back to the framing it opened on |
| `knowledge-graph-<project>` | boot | one per sample project, generated from the dataset: the title-bar button alone for the open project (contoso-web), and for the others the picker, that project's row, the open project's row to untick it, and the picker again. A single map frames close enough for each conversation's title to show. Under `loop=1` each plays the same orbit and Reset view as `knowledge-graph` |
| `quick-find-results` | boot | the palette, then `type` a query; the seed answers with a keyword match over its own rows (Quick Find below). Under `loop=1` it arrows down the results and narrows the query to `auth middleware`, then the frame cuts and `auth` comes back behind the veil with its first result selected; the pointer stays out of it, since a result under the pointer takes the selection |
| `settings-<tab>`, one per tab in `settings-tabs.ts` | boot | the gear, then the tab button; generated from one tab-to-alt map the unit test pins to `SETTINGS_TABS`. An entry may carry config: `settings-dictation` switches dictation on, since off it greys out every row below the switch. Every entry carries a choreography that works its tab's own controls under `loop=1` and puts them back: a project tab (General, Agent) takes the panel's project switcher to spring-petclinic and back; Theme picks the first tile that is not the frame's theme, re-theming the frame, and then the frame's own tile again (named by the player's `data-demo-rest` mark, since the host passes the theme); Board steps column width through Narrow and Wide; Terminal steps the cursor style, which the panel's terminals take live; Developer turns the debug overlay on and closes it with the overlay's own control; Hotkeys opens a Rebind capture box and clicks away from it; Language picks Deutsch and holds its restart prompt as the pose, and its `focus` names the prompt beside the panel, then Restart now switches the frame to German in place and the cut switches it back (Display language below); Privacy scrolls to its contact line and back. Dictation and Knowledge Graph step a segmented choice through its options back to their own; Git, Task, MCP Server, Browser, Changes, Behavior, Performance, Notifications and Agent Browser make their edit forward (a branch picked, a switch flipped, groups folded to reach Diagnostics) and end on a cut, which puts the values back behind the veil; Shortcuts opens its Presets menu and Workflows its Template variable menu, and each closes it. Mobile Devices only hovers its two guides: the bridge switch would start a pairing no visitor can finish |
| `card-drag`, `card-menu`, `window-dock` | boot | a choreography whose pose is the gesture in flight: Add user auth flow lifted from To Do and held over Executing (To Do, because a card dropped back there ends its session as main does, which a loop needs), a right-click on a card, a window dragged to the right edge. Under `loop=1` each completes the gesture and comes back to it: the card is dropped and its agent starts from the recorded boot, then the frame cuts and the card goes back to the top of To Do behind the veil; the pointer runs down the menu's items and a click on empty board closes it; the window is dropped and docks to the right half, then the frame cuts and it is dragged back out to float again behind the veil |
| `board-workflow-links` | boot | the `board-workflow` seed and a choreography that rests the pointer on Refactor API error handling through the board's dwell: the board draws a workflow card's links only while the pointer rests on it, so no click reaches them. Under `loop=1` the pointer moves to Add user auth flow, which draws its one link, and back |

Three things the catalog corrected against the source while it was seeded, recorded so the next
reader does not re-derive them: `lastSettingsTab` is renderer store state and never reaches
config, so a settings tab is a click, not a config key; the Monitor's layout does persist
(`config.monitor.layout`) though its open flag does not; and `board` clicks, so it is `boot`.

Terminal type size is decided per scene by one rule: a terminal that is the SUBJECT of its
figure is at native type, and a terminal that is context beside a panel may be held. Every task
recording is 154 columns, and the width 154 columns take depends on the display: xterm's WebGL
renderer floors the cell to device pixels, so the 12px Consolas cell is 6.0 CSS px at 100
percent, 6.4 at 125 and 6.5 at 200, and a machine without Consolas draws Courier New or its
metric clone Liberation Mono (what CI's runner has, and so what the posters are shot with) at
7.0. No fixed fraction of the frame fits all of them. The floating terminal scenes (`task`,
`dictation`, `window-dock`, `command-terminal`) therefore mark their window `fitToRecording`
with the session it shows, and the seed sizes it before the renderer mounts
(`fitLayoutBlob` in `demo-dataset.ts`): the cell measured the way xterm's `CharSizeService`
measures it and floored the way its renderer floors it, the scrollbar gutter measured the way
`fit-addon.ts` measures it (the app's 8px on classic scrollbars, 0 on overlay or hidden ones),
and the frame's border. The terminal then takes exactly the recording's columns at native
type, and nothing is left empty on the right. At 100 percent the window comes out at about 0.58
of the frame, the window manager's own default; at 2x with Liberation Mono, about 0.68. The rect
carries about a row and a half of margin over the recording's 37 rows, so the recording's rows
always fit whatever the face's line height; the spare rows show the rows above the recording's
screen, as a taller terminal on the desktop does (Live replay below). The width is fixed at load,
and against the 1600px frame the recordings are measured at (or the frame itself when that is
wider), so a smaller embed keeps the stage's proportions.

Before this, the floating scenes opened at 0.64 of the frame, sized for the rig's 2x Consolas
cell, and two bands followed. At 100 percent the window fitted 170 columns and held 154 at
native type, about 100px empty. At a 7.0 px cell it fitted 146, which the old width-only
layout choice answered with the 115-column tiled recording at native type: a fifth of the pane
empty, the v0.43.0 posters. The `conversation` scene keeps that plain 0.64 rect, since it has
no terminal to fit.

In a tiled figure the terminals ARE the subject, and a half-width pane holds a 154-column
recording at about two-thirds type, so the two tiled scenes rest on a second recording of each
session at the tiled width, the way the Command Terminal boots carry one
(`terminal-<project>-tiled.json`): the manifest's `tiled` field names the sibling, the matrix
records it at `geometry.taskWindowTiled` (or `commandTerminalTiled` for a Command Terminal
session), and the seed shows whichever of the two fills more of the window's pane (Terminal
recordings below). `windows-tiled` tiles the middleware and api-client windows in the footprint a
dock produces (two panes at the engine's 750px minimum, at the floating window's height, so the
rows stay 37 and only the width changes); `command-terminal-tiled` is the toggle and then New
terminal, so its second window is the boot the frame starts for a visitor. Both terminals of each
are at native type at the rig's launch.

The same rule gives the Browser and Changes scenes their narrow terminal. The panel is the
subject there, and the width a native terminal needs truncates the address bar and the note
field, or clips a split diff mid-line. Because the middleware session has a tiled recording, a
pane that narrow is shown better by it (the seed's `layoutFor`): about 110 to 118 columns
against its 115, so at the configured type where the pane is at least 113 columns, and at about
0.85 of it where it is narrower, the pane held at the grid it takes there. Either way the
terminal fills the tall pane, with the rows above the recording's screen, where holding the
recording at its own grid once left 300px empty below it. Below the seed's 0.6 floor the
terminal would keep the configured type with each row cut at the edge, so the context terminal
is never narrowed past it.

One scene needs dataset work the sample install does not carry for every session: the
conversation viewer opens on the one session with a transcript (Transcripts below). Two settings
scenes render empty lists on purpose and say so in their alts rather than being deferred:
`settings-shortcuts` (the sample install configures no project shortcuts, so the tab is its Add
Shortcut and Presets controls) and `settings-mobile` (no device is paired). Seeding either is a
dataset decision, not a bug in the scene.

### Choreography and timelines

A live frame under `loop=1` should move, because motion holds a visitor's eye better than a still.
A scene says how, as data, in one of three fields, and `tests/unit/scene-registry.test.ts` fails a
scene that says none:

- **`choreography`**, a list of steps the frame plays by itself, as a visitor would. The pointer
  steps are `hover`, `click`, `contextmenu`, `drag` (to a target, or `by` a distance as fractions
  of the frame, and with `hold` to stay pressed), and `drop`, which lets go of a pose's held drag
  where it is, each pointing at a selector's centre or a point as fractions of the frame. The
  player stamps `data-demo-rest` on whatever is checked, selected or pressed when it reads the
  rest, so a step can name the option the frame opened on (the theme a host passes) as a
  selector. The keyboard steps are `type` (a
  field edited to a text a keystroke at a time, back to what the two share and then on, after a
  click into the field unless it has the focus; `''` clears it), `key` (an arrow key on whatever has
  the focus; never Escape or Enter), `choose` (an option of a native select: the pointer clicks the
  field and the value changes with the events a pick sends, since no page can draw the browser's
  own option list), and `hotkeyDown` and `hotkeyUp` (a mouse hotkey held and let
  go through boot.js's own `pressCombo`, balanced within a cycle). `scroll` moves only the box a
  wheel over an element would scroll. It centres the element vertically and moves it horizontally
  the least distance that shows it. It is not `scrollIntoView`, which also scrolls the page that
  embeds the frame. At most one `pose`, and at most one `cut`, which comes after the pose with a
  step on each side of it (below). A step may carry `waitFor`, a selector its effect must produce
  (the app's own timing: a dwell, an animation, a check), and `ms`, the pacing
  after it. Any step the next depends on waits for its effect; `ms` is pacing only. A removal is
  waited for as `body:not(:has(...))`, since a popover or a dialog stays mounted through its exit.
- **`timeline`**, what main does at a moment on a working session's replay clock. The one moment
  is `at: 'end'`, where the recording ends, which for a recording cut by `stopWhen` is the moment
  the cut names, so no offset is typed by hand. The one action is `move`: the card changes column
  through the same `tasks.move` a visitor's drag takes (into Done it is archived, as main does),
  the Monitor row's column follows, and the push `MOVE_PUSH_BY_ORIGIN` in `task-move.ts` sends for
  its origin goes out. Origin `agent` is a `kangentic_move_task` landing (`TASK_UPDATED_BY_AGENT`);
  origin `workflow` is a workflow step or an engine start (`TASK_MOVED_BY_AUTOMATION` and the
  workflow's change). A workflow move is the engine's to choose, never the scene's, so the
  registry test replays each one through `src/shared/workflow-route.ts`: a step needs a session
  whose turn ended on its own, an Automation agent, and the next column on the task's route; a
  start needs every blocker in Done and the route's first column. The seed schedules the actions
  inside `scheduleSessionClock`, so they fire whether or not a terminal is open, and
  `restartSession` undoes them quietly as the terminal repaints from its opening frame (an
  archived card is unarchived back where it was). `task-mcp` and `workflows` carry one.
- **`motion`**, a sentence saying why a scene moves with neither, such as a terminal replaying.

`demo/choreography.ts` plays a choreography, a chunk `boot.js` loads only when the frame plays one.
A browser gives a script no real pointer, so it synthesizes the events one makes, in a browser's
order: each move hit-tests the point and sends the over, out, enter and leave transitions, a
pointermove and its compatibility mousemove; a press sends pointerdown and mousedown, and a release
pointerup, mouseup and click. That one sequence drives dnd-kit, the window manager's title-bar
drag, React Flow, the board's link preview and React's hover handlers alike, and a pointerdown the
page prevents takes the mouse events with it, as in a browser. What a script cannot get, it stands
in for: `:hover` is mirrored (each same-origin `:hover` rule copied under `[data-demo-hover]` in the
same parent rule, the attribute set on the element under the pointer and its ancestors); pointer
capture is kept by the player for its own pointer, since no browser captures a pointer that is not
pressed for real (Firefox even throws), so a window drag's moves and release reach the frame that
captured them as they would; and the pointer itself is drawn, the product accent arrow, so a menu
that opens reads as a visitor's click. The arrow fades in when a cycle starts and out at
rest, where the pointer leaves the page, so no hover style or tooltip stays up in the rest frame; a
cycle of keys alone never draws it. A travel follows its target until it stops moving, so a click
lands on a control a collapsing group is still carrying, while a drag's drop point is measured once,
since a sortable list moves its items out of the dragged one's way. The renderer reads none of it. The demo tier runs Chromium only, so a change to the player is
checked by hand in Playwright's Firefox and WebKit too; Firefox is where the capture refusal showed.

Each cycle starts and ends on the poster's state. A choreography with a `pose` (a card held
mid-drag, a menu open) plays up to it before the reveal, in a still too, unpaced, with no pointer
drawn and no timer, so the still, the poster and the live frame's rest are one frame. Under
`loop=1` the cycle is the steps after the pose and then the steps up to it again; a choreography
that is only a pose holds it. A pose that holds the button down (a card carried over Executing, a
window over the dock edge) is a hand mid-gesture, so live it hangs only a half-second beat after
the carry lands and then drops, with its pointer still drawn: nobody holds a card still in the air
for seconds. A pose with the button up (a menu open, the pointer resting on a card) gets the full
rest between cycles. Without a pose the frame rests where the boot steps left it. At ready
the player records the rest (each lane's cards in order, the open dialogs but one already closing,
and inside the scene's `focus` every form value and selection state, a terminal's and the diff
editor's own fields aside, and which text field holds focus, since a field a cycle leaves focused
draws a ring the poster does not have) and compares after every cycle: a choreography that
drifts logs an error and stops, and the demo tier, which plays every choreography once at a divided
pacing (`window.__demoChoreographyRate`, set by a test's init script, never the URL), fails on it.

A cycle shows what a person does next on that screen, and how it gets back to rest decides its
shape. Looking around comes back by itself: a tab picked and the first one again, a segmented
choice cycled through its options, a menu opened and closed, a filter's sort clicked back to none.
An edit that is the scene's point does not, because undoing it in view reads as a script, not a
person: a title typed and then backspaced, a switch flipped off and straight back on, a card dragged
over and dragged home. So the edit plays forward, ending where a person would stop (often with the
pointer on Save, Create or Send, never pressed), and then a `cut` step ends the story. The one
press is the `browser` scene's Send, because what it starts is a recorded agent turn the seed takes
back at the cut (Live replay), not a write the mock would keep. The frame
fades to the app's surface color over 450 ms. The steps after the cut play at once behind the
opaque veil with no pointer drawn, the reset's last layer closes and paints, and the frame fades
back in at rest with the pointer beside the next cycle's first target. In a pose scene the reset
runs from the cut to the end of the steps after the pose, and the steps up to the pose then play in
view, since they make the poster's gesture. The player stamps the phase on
`<html data-demo-cut>` (`out`, `reset`, `in`), and the demo tier plays every scene with a cut once,
asserting that each change the reset makes lands under the landed veil with no pointer and that
nothing changes while the frame fades back in, a card the reset dropped still playing its drop
animation included. An activity mark changing counts as something the reset put back but is not
held to the fade-in, since a session's own clock can flip one at any moment; the Send test holds
the `browser` scene's mark to the reset.

A visitor's own click, key, wheel or touch stops the choreography for the frame's life: a held
pointer is released where it stands, the hover marks clear, the arrow goes, and a veil mid-cut is
taken away, leaving the frame where the reset had got to. Sessions keep
looping. The site's loop frames are `inert`, so in a loop that is for a direct visit. A pose is
let go the same way in every frame, loop or not and a still too, because the site's take-control
dialog never passes `loop=1` and a reader who prefers reduced motion gets `still=1`: without it a
visitor would be left with a card stuck mid-drag. And a key a script dispatched never posts
`kangentic-demo-escape`.

Two more things hold a loop still, both for the visitor's sake. A visitor whose system asks for
reduced motion (`prefers-reduced-motion: reduce`) gets the rest, held, with no pointer drawn: WCAG
2.2.2 asks for a way to pause motion that starts by itself, and that setting is the one a frame can
read before anything moves. The desktop app does the opposite on purpose: it forces Chromium's
no-preference switch and stops motion only through its Animations setting, because a stale cached
`reduce` once froze every activity mark (`docs/architecture/renderer/activity-marks.md`). The renderer's reduced-motion
styles therefore apply only here, in a visitor's own browser. The host owes its loop frames a
visible stop control, since an `inert` frame takes no click (Where it runs, above). And a cycle
starts only while the frame is on screen: its tab in front and, embedded, some of it inside the
page's viewport (an `IntersectionObserver` on the frame's root
reports against the top-level viewport), so a page of loop frames plays only the ones a reader can
see. A typed keystroke is the sequence a browser sends, keydown, beforeinput, the edit, input and
keyup, so a handler that prevents the key keeps the character out, as Testing Library's
`user-event` models it.

### Quick Find

The desktop runs FTS5 in main over the tasks, the backlog, and the sessions' events. The seed
answers `search.everything` with a keyword match over the same rows it installed, scoped the way
the palette asks (this project or all), and builds the `task`, `backlog`, and `session_event`
hit shapes, so a visitor's query finds what the desktop's would and `quick-find-results` types
one. Conversation hits (the memory index) have no rows to search here and do not appear.

### Workflows

The sample install seeds no workflow. A workflow card draws its strip and step track on the board,
and the view toggle draws a running mark, so a workflow in the dataset would change every contoso
figure. The `workflows` and `board-workflow` scenes seed one instead: Harden the API, running on
contoso-web, over six cards the install already has. Two are done, two are mid-route, and two wait
in To Do, so the canvas shows both a met link and an open one. The mock lists a started workflow's
tasks by `workflow_id`, which the scenes' `tasks` patches set. `workflow-draft` seeds a different
workflow, Invoice PDF export, planned by its own agent from the contoso backlog item and not
started, so its tasks are the draft's own and no board card changes (Workflow agent below).

The mock reads a task's route against its own board's columns (`boardLanes`). The sample install
tags each project's lanes, and a route read across all three drew about seventeen stops on every
track. The smoke tier counts each card's stops.

Two of the `workflows` steps answer the view's own behavior. The canvas fits its cards when a
workflow opens and never on a resize, so the steps collapse the agent pane, leave the view, and
open it again at its full width; the collapse is store state and survives the round trip. The view
also selects the first task in run order when it opens, which restyles the links around that task
and fades the rest. The last step clicks empty canvas, as a visitor would, so every link shows its
own state and the inspector shows the run order. The cards then sit at their own size with room
around them, because the canvas never fits past 1:1 (`FIT_VIEW_OPTIONS` in `WorkflowCanvas.tsx`);
at 1600 by 1000 six cards need less than the canvas has. Filling it would take a zoom the desktop
never opens at, so the frame keeps the app's fit.

The pane is collapsed for a second reason. Harden the API's agent has no recording: its members are
cards the install already has, each with its own recording, and a real agent's plan would not be
theirs. The mock starts a session when the pane opens, and its terminal would be empty. A visitor
who expands the pane sees that empty terminal, the one place this view is quieter than the
desktop.

#### Workflow agent

`workflow-draft` is the other way round: its plan is a recording's. The capture matrix records the
workflow agent planning Invoice PDF export (the manifest's `workflowAgents`,
`scripts/lib/demo-mcp-capture.mjs`) against a running `/preview` seeded with the contoso board, the
way a user makes one: the backlog item as a card in To Do, and the workflow made from that card. Its
launch is the desktop's, read from the preview (`POST /workflow-agent-launch`,
`src/devtools/main/workflow-agent-launch-route.ts`): the first message built over the preview's own
board, and the MCP URL whose `workflow-` segment limits the agent to the read-only and planning
tools. Claude starts read-only in the project's checkout, as `workflow-agent.ts` starts it, with
Verbose output on so each call prints. After the run the rig reads back the plan the agent saved
and writes it to `workflow-plans/wf-cw-invoice-pdf.json`; the scene's draft is that file, so the
canvas draws the plan the pane shows being saved, and `scene-registry.test.ts` holds the two equal.

The run is two turns. The default first message asks for as few tasks as the work allows, and the
agent saved one; the rig then types the user's answer to the choices its reply offered (`followUp`:
the server side first, then the billing page on top of it), and the agent saved the two linked
tasks the canvas draws. The pane opens on the recording's end, idle, with the scene naming Claude as
the Workflow agent so the pane opens it rather than asking for one. The scene's draft names no
source task: the sample install keeps the item in its backlog, and the card it was made from exists
only on the preview's board, which is why the reply mentions #69. A workflow agent passes Claude no
permission-mode flag, so Claude starts in the user's own default mode; the rig's settings layer
names Claude's built-in default instead, since the recording machine's preference is not the
sample install's.

### Scene-only rows

A card only one figure needs is not a row of the sample install. A new contoso card would change
every contoso figure, the Monitor's row count and the usage, and the Knowledge Graph fixture counts
the install's tasks, so a dataset row would also need that graph rebuilt from conversations Claude
Code deletes after thirty days. The workflow and completed-task seeds are scene data for the same
reason. `DEMO_SCENE_TASKS` and `DEMO_SCENE_SESSIONS` in `demo-dataset.ts` hold such rows, and a
scene adds one by naming its task in `rows`. The seed then adds the task and its session before it
derives anything, so the card, the Monitor row and the clock describe it like any other. The
session is recorded like any other too, and the build refuses one without a recording.

The row's recorded sessions (their final and opening frames, diff, peeks, peek timeline, trail and
blame) are not in the seed, since every frame loads the seed and only the scene's frames show
them. The build emits each row's sessions as their own script, `scene-rows/<task>-<hash>.js`
(`buildDemoSceneRowScripts` in `demo-dataset.ts`), and `boot.js` writes it into the page with
`document.write` for each row a frame names. That makes it parser-inserted: it runs right after
`boot.js` and before the mock and the seed, so the seed folds the row in with its sessions already
on the page, exactly as when they were inline. The Knowledge Graph's lazy fetch would not do here.
The seed folds rows in synchronously and the renderer's modules are deferred, so a fetch, or a
script added with `createElement`, lands after the renderer has read the bridge. Fetching only the
frames when a terminal asks for one would not do either: `task-mcp`'s `ready` is the window title,
so a poster could be shot before the frame painted. A row script that does not load (a 404) shows
the error card naming the row, and the seed refuses a named row whose sessions are not on the page.
The marketing captures write no row scripts, so their seed carries the rows inline.

There is one: Validate request bodies, #68 in contoso-web's Code Review, whose Claude Code session
is the MCP recording (An agent calling Kangentic's MCP tools, below). Its ticket is the next free one
after the archived history, and it is a literal rather than computed: the recording prints it, so
`tests/unit/scene-registry.test.ts` fails when a dataset change moves the next free ticket, and
when the recording stops printing the row's number. The Knowledge Graph and its capture leave the
session out, like every figure but its scene, and it has no resume boot.

### Knowledge Graph

The map a frame opens from the title bar, and the `knowledge-graph` scene, are the Knowledge Graph
main's own pipeline built over the sample install's recorded conversations: index, embed with the
default model (bge-base for the committed fixture, see below), nearest neighbours, the 3D layout,
regions at three granularities, and region names from the task titles. `scripts/capture-demo-knowledge-graph.mjs` registers the three projects in a
running `/preview` (`seed-knowledge-graph-demo.ts`, dev only), points each recorded session's row at
its agent's own history, opens each project, waits for the sweep, the embedding drain, the map and
its names, and reads the snapshots back into `tests/captures/fixtures/demo/graph/knowledge-graph.json`.
Nothing on the map is placed or named here. Like the message trails, it cannot be rebuilt from the
repository: the conversations are on the machine that recorded them, and Claude Code deletes its
own after `cleanupPeriodDays` (30 by default), so a re-derivation has to run while they exist.

A node is a conversation main can index. That is every recorded task session whose agent keeps a
transcript Kangentic reads (Claude Code, Codex CLI, Gemini CLI, OpenCode), and each archived task's
run (below), the install's older history included.

That history is what gives the map its depth. `tests/captures/fixtures/demo/archived/history.json`
lists 177 older Done tasks across the three projects, each with one real headless run on Sonnet 5.5
at low effort. The two upstream samples' history is their own: each task is one of the sample's
merged, human-made commits (no dependency bots, no release or typo commits), titled from its
subject, and its run starts at that commit's parent, so the work was really there to do.
contoso-web has no upstream, so its history was drafted and reviewed. Twenty-six tasks were
swapped out after their runs. Sixteen left no change, since a run that finds no work is not a
finished task. Most found the work already done at the parent commit, or a drafted ask named a
page the scaffold does not have. Two boutique runs declined an ask too vague to act on, and one
ended without a single tool call. Ten contoso-web tasks installed a package. The scaffold commits
no lockfile, so each run counted a new `package-lock.json` of 3,000 to 4,700 lines, which a
repository that commits its lockfile never shows. Replacements take new ids after the last, and
the guard holds every run to at least one changed line. Archive dates spread from the
day after each project joined the install to four days ago, oldest commits oldest, and the history
takes ticket numbers after each board's, so no card on a board changed number.

Main indexes at most 25 conversations per project open (`MAX_SESSIONS_PER_SWEEP`). The capture
opens a project again whenever its sweep stops with conversations left, as a user's later visits
would. Cursor and Copilot sessions get no node, because their adapters have no transcript parser.
The desktop draws none for them either. The Command Terminal is transient and has no row. The
fixture's `withoutNode` names each recorded session without a node and the reason, and
`tests/unit/demo-knowledge-graph-seeded.test.ts` holds every recorded conversation to being drawn
or named.

The fixture keeps what the pipeline computed: each node's place, size, regions and agent name (the
adapter's display name, which main resolves), the links, the neighbour lists, the regions at every
granularity, and the coverage and Index counts. A node's title, ticket, model, effort, cost,
duration, tokens, outcome and last activity are joined from the dataset's rows when the graph
first opens, as main's `documentMetadata` joins the same rows on the desktop, so a node agrees with
its card. The web build ships the maps as their own file, fetched at that moment, and no board
frame loads them (What the page ships, below).
The counts are the install's own because the capture registers each project at a repository with
the History pane's history: task records are its tasks plus its backlog, and commits are the
scaffold's commit plan for contoso-web and the one commit of each shallow upstream clone. Settings, Knowledge Graph
reads the same counts through `getStatus`, summed with main's shared helpers
(`DEMO_KNOWLEDGE_GRAPH_STATUS`), with semantic search on and the default model (Granite R2)
present. The committed maps were embedded with bge-base, before Granite R2 became the default.
Nothing a visitor sees reads the model tag, so the frame stays consistent, and a fresh run of the
capture re-embeds them with the default. No Ask agent is chosen, so Enter in the Ask box opens
Settings, as on a desktop where nobody picked one. An Ask answer is not seeded: an honest one needs
a recorded answer run and a mock that refuses every other question.

The map draws with three.js on WebGL 2. A browser that cannot give it a context shows the app's own
"The map needs a GPU" card, and the region pills and island labels stay at zero opacity, since only
a drawn frame places them. So the scene's `settle` names those labels: the rig shoots only once one
is shown and none moves (the camera flies to the three islands after the scope click), and it
refuses to write a poster while the no-GPU card is up (`NO_GPU_FALLBACKS`). The smoke tier asserts
the same on the headless shell CI runs, which is the browser and launcher the release's poster job
uses: Playwright's Chromium launcher passes `--enable-unsafe-swiftshader`, so the shell gets WebGL 2
on SwiftShader.

```
node scripts/capture-demo-archived-runs.mjs       # the archived tasks' runs, into archived/runs.json
node scripts/capture-demo-knowledge-graph.mjs     # needs a /preview of this worktree with Allow Unsafe
                                                  # Operations on, and the default embedding model cached
```

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
`demo/guest/` that stands in for what the project serves there (`guest_page`), so the address bar
shows the desktop's URL and the pane shows that app's page. Any other URL loads nothing. Inert:
Inspect (finds nothing), history (always empty), and the agent driving the pane. Send's capture
resolves with a blank image at the guest's size, which the mock keeps no more of than anything
else; the screenshot a recorded Send's agent reads is the page the capture matrix rendered (Live
replay).

`demo/guest/contoso-web.html` has the scaffold's data and an authored presentation. The data is
`scripts/demo-repos/contoso-web`'s, signed in as the store's admin user (`server/store.ts`): that
user, the one team subscription, and the two invoices, with a nav and a button that name the
routes in `server/routes.ts`. No value on the page is invented. The layout and the styling are not
the scaffold's. The scaffold ships no stylesheet, and its `src/App.tsx` renders a serif heading and
one bullet, with no header and no invoices. That matters because kangentic.com's landing page shows
this scene as its Embedded Browser panel, where the page is most of the picture.

Building that presentation into `App.tsx` would have kept the page and the scaffold identical, and
three recordings rule it out. The api-client session edits that file in both its single and its
tiled recording, and each recorded diff carries the old file whole. The auth task's accept-edits
boot (`spawn-task-cw-auth-acceptEdits.json`) reads it with the other front-end files and prints
their combined line count. Changing the file means re-recording all three on Claude, and the new
runs would change the api-client card's message trail, its Monitor peeks, and the `windows-tiled`
scene. Regenerating the history fixture without them would also leave the api-client blame marking
untouched lines as the agent's. So the guest drifts from the scaffold in presentation only. The
next time those sessions are re-recorded, give `App.tsx` this page's header, subscription card, and
invoices list plus a stylesheet, and rebuild the guest from what it renders.

Three constraints hold whatever the page shows. It fetches nothing off-origin, like the rest of the
build (the smoke tier asserts that on the `board` scene, which never loads this page), so no remote
font or icon can land late or fail. It has one fixed light palette and no `prefers-color-scheme`,
because the iframe sees the visitor's OS setting and not the frame's `theme=`. And it never
animates, so stills and posters stay deterministic. `tests/unit/demo-guest-pages.test.ts` holds
every page `DEMO_PROJECTS` names to all three.

### Dictation

`demo/boot.js` replaces `getUserMedia` with a silent stream from an audio graph, so a press of
the push-to-talk hotkey runs the renderer's whole pipeline with no permission prompt: the mock
grants the mic, starts a stub engine session, and the app's own audio worklet runs over silence.
The chip appears anchored to the target in its live state: a task terminal in `dictation`, the
Settings search box in `dictation-field`. The second one is the point of having both. Dictation
types into any text field in the app, and a figure of the terminal alone reads as a terminal
feature.

What the engine "hears" is one recorded utterance, not authored text.
`node scripts/record-dictation-demo.mjs` bundles the dictation worker's own engine code
(`engine-build.ts` and the engines it builds) with esbuild, resolves the selection the demo's
Dictation tab shows, and feeds it a clip of "push to talk" the way the renderer's worklet does:
20 ms frames of 16 kHz mono PCM. The clip is synthesized with sherpa-onnx's Kokoro TTS, so it is
regenerated rather than committed, and `--wav` takes a recorded clip instead. The script writes
each live partial with the audio time that produced it, measured from the press, and the refined
final with its decode time, to `tests/captures/fixtures/demo/dictation/settings-search.json`
(`DEMO_DICTATION_RECORDING`). Nemotron streamed "Push to" at 1.2 s and "Push to talk" at 1.76 s,
and Parakeet v3 closed it as "Push to talk." in under 100 ms.

The seed replays it on a press. Each partial goes out through the mock's partial push on the
recording's clock, and the renderer types it into the focused field, so the Settings search
narrows as the words arrive. `dictation.stop` sends main's final push and answers the refined
text after the recorded decode time. A visitor who lets go before the last partial gets what the
live model had heard by then. The clock starts when the frame is revealed, so a key held in the
scene's pose does not spend the utterance behind the boot veil. A still plays none of it, and the
choreography's pacing divisor divides this clock too, so the demo tier's divided cycle still lets
go after the last word. The phrase names a Dictation tab row on purpose: a random sentence would
filter the tab to nothing. `tests/unit/demo-dictation-recording-seeded.test.ts` fails when the
recording is missing or empty, comes from other models than the tab names, commits a final that
names no Dictation setting, or stops reaching the seed.

The final's closing period found a desktop bug on the way. Settings search matched each word as a
raw substring, so "talk." matched nothing and the panel switched to No results on release. It now
strips sentence punctuation and quotes from each end of a word (`settings-search.tsx`).

In a terminal the words are the CLI's own echo of what main typed into the PTY, which no mock can
draw, so `dictation` still shows the chip and nothing typed.

The Dictation tab reads `dictation.getInfo`, and the mock's own answer lists no models, so both
model rows read None whatever the config says. The dataset answers it instead with main's
`buildDictationInfo` (`src/main/transcription/dictation-info.ts`, the same function
`TranscriptionService.getInfo` calls) over a seeded machine on the accurate tier
(`DEMO_DICTATION_INFO`). The default config therefore selects what the desktop does: the Best
preset, Nemotron streaming live and Parakeet v3 to refine, both cached and Ready.
`tests/unit/demo-dictation-info.test.ts` fails if that answer ever loses a model. The answer is
fixed at the default config: after a visitor changes Mode, the dropdowns follow the new choice
but the model list under them still names the default pair.

`dictation-field` resolves its target from `document.activeElement`, where `dictation` resolves
it from the restored window's focus. So the scene needs DOM focus, which a boot `click` on a text
field gives it. Under the boot veil that needs one more step: the veil hides the app with
`visibility: hidden`, and Chromium focuses nothing under a hidden ancestor, so a click on a text
field swaps the veil for opacity before it focuses. Every other scene keeps the visibility veil,
so none of their terminals or dialogs take focus they did not have before. The scene also waits
for the settings panel's slide-in to end before it presses: the chip anchors to the field wherever
the field is at that moment, and the ready message measures the chip once.

Where this scene can boot live, as checked against the build: a top-level page, `stage.html`, and
a cross-origin iframe on a secure page (the site's case) all focus the field and post the chip's
rect. Two hosts cannot. An `inert` iframe focuses nothing, so the ready gate times out; the embed
snippet above uses `inert`. And a page that is not a secure context (plain http, or the
`about:blank` host the smoke tier builds) has no `navigator.mediaDevices` in its frames, so the
silent microphone is never installed and the chip shows the error. That second one is shared with
`dictation`, whose gate is the chip alone and so boots on the error. A poster is shot in a real page
and is unaffected by either. A third is a test browser, not a host: Playwright's WebKit build for
Windows has neither `navigator.mediaDevices` nor Web Audio, even on a secure page, so neither
dictation scene can be checked there (measured 2026-10-17). Safari has both; check the two scenes
in WebKit on macOS or Linux.

### Display language

On the desktop, Restart now in Settings > Language saves the language and restarts the app, which
comes back in it (`docs/architecture/i18n.md`). A page cannot restart, so the frame switches in
place. `demo/boot.js` wraps `language.setLanguageAndRestart`. The mock's own call still checks that
the language ships, saves it to config, and records the request. The wrapper then loads
`demo/language.ts`, through the loader `demo/language-entry.ts` defines, which runs the renderer's
own `activateLocale` and sets `<html lang>`, as `src/renderer/index.tsx` does at boot. The call
resolves once the switch has landed, so the prompt closes on the switched frame. The renderer is
not told it is in a demo: it asked main to restart, and the frame answered by switching.

Every frame loads the one-line loader (`demo/language-entry.ts`), but none fetches the switch
chunk (`demo/language.ts`) or a catalog until a switch is confirmed, so a still, a board and the
heap budget are unchanged. Every label follows the switch because Lingui re-renders its subscribers
(`useLingui()`, `<Trans>`) and everything they render. A component that shows translated text and
sits outside that re-render would keep the old language. `tests/demo/static-demo.spec.ts` switches
`settings-language` to German and fails on any visible text that is still an English message the
German catalog translates. It skips terminals, cards and column names, which stay English by design,
and checks first that the same scan finds the frame's labels while it is still in English.

`settings-language` plays it. Deutsch's restart prompt is the pose, so the poster is the prompt.
Live, Restart now switches the frame to German, and the cut switches it back to English behind the
veil, picker and prompt alike.

### scenes.json, the hand-off to the site

The build emits `scenes.json` UNHASHED at the root, beside `index.html` and `stage.html`:

```json
{ "version": "0.41.0", "frame": { "width": 1600, "height": 1000 },
  "scenes": [ { "name": "board", "reach": "boot", "alt": "...", "description": "..." }, ... ] }
```

Generated from the same `SCENES` the page boots, so the two cannot drift; the smoke tier asserts
it is served, lists exactly the registry's names, and names the version the frame reports. It is
what a docs page reads: the site fetches it from the deployed demo at build time, validates every
figure's scene name (an unknown name fails the site build rather than rendering the error card
inside a captioned figure), and takes `alt` and `version` from it. Every scene's `reach` is
`state` or `boot`, and every one boots. A URL
cannot lag the way a vendored package does, which is the failure `@kangentic/branding` plus
`scripts/sync-brand.mjs` is known for. Placing frames on pages is the site's job (kangentic.com
#78 and #79); this file, the registry, and the poster set below are the whole app-side contract.

### The poster set, the second hand-off

A docs figure is an iframe of one scene, and before that frame boots, and instead of it in print,
under no JS, on a phone, and in a browser without CSS trig functions, the figure shows a poster:
a still of the same scene in the same theme. The site does not shoot its own (it would duplicate
the rig); the rig shoots them here and every release attaches the set:

```
demo-posters-<version>.zip
  manifest.json
  board.clay.frame.png
  board.rust.frame.png
  ...                       one pair per scene in scenes.json, held gestures included
```

```json
{ "version": "0.42.0", "frame": { "width": 1600, "height": 1000 }, "scale": 2,
  "scenes": { "board": { "clay": "board.clay.frame.png", "rust": "board.rust.frame.png" }, ... },
  "focus": { "board": { "clay": null, "rust": null },
             "new-task": { "clay": { "x": 0.2375, "y": 0.1735, "w": 0.525, "h": 0.653 }, "rust": { ... } }, ... } }
```

The themes are `clay` and `rust`, the product pair the site embeds with (the rig's own default is
`night,sand`, which the site does not use). Every poster is the frame at 2x, 3200 by 2000, with
the 40px title bar kept; the site crops it. `version` is the string `scenes.json` carries, and the
site fails its build when the two differ, when a figure names a scene the manifest lacks, or when
a named file is absent, so a stale or partial set cannot ship quietly. That is the
`sync-brand.mjs` precedent with its failure mode fixed.

`focus` gives every poster the rect around its scene's `focus` elements as fractions of the frame, the
same `{ x, y, w, h }` the ready message posts, so one crop routine serves the live frame and the
poster. It is `null` for a scene that names no focus element. The rig measures it on the still it
just shot, through `boot.js`'s own `__demoBoot.focusRectOf`, so a held gesture gets its rect after
its pose, and it writes one `<scene>.<theme>.frame.focus.json` beside each PNG. A scene that
names a focus element the rig cannot find fails the run instead of writing `null`. The map sits
beside `scenes` rather than inside it, so a `scenes` entry still holds only theme keys. The rect
is only as tight as the element the scene names: the Column Manager scenes name the whole dialog,
so a crop to one row of it is still the site's to choose.

`npm run demo:posters` (`demo/posters.mjs`) is the command. It refuses a missing or stale build
(`dist/demo/scenes.json` has to carry `package.json`'s version), runs
`tests/captures/features/scenes.capture.ts` with `CAPTURE_THEMES=clay,rust`,
`CAPTURE_RESOLUTIONS=frame`, and `CAPTURE_OUTPUT_ROOT=dist/demo-posters/` (so the shots land in
one known directory instead of a timestamped `captures/` run, which a Playwright retry would
otherwise split), then checks the shots against `scenes.json` (every scene at every theme, every
PNG exactly 3200 by 2000 by its header and whole by its IEND trailer, every focus sidecar present
and either `null` or a rect with a positive size, no PNG the manifest would not name) and zips
them, posters stored rather than deflated and the sidecars folded into the manifest, as
`dist/demo-posters-<version>.zip`. Nothing decodes a poster along the way; the two ends are what
a header-only check misses when a shot is cut short. The pure half is
`scripts/lib/demo-posters.mjs`, covered by `tests/unit/demo-posters.test.ts`.

`release.yml`'s `demo-posters` job runs it after `publish-release`, beside `deploy-demo`, and
attaches the zip with `gh release upload --clobber`, so a re-run of a finished release replaces
the asset in place. It is deliberately not in `scripts/release-assets.js`: that manifest is
verified before the job runs, and listing the zip there would fail every release. Being after
publish also means the release stands when the job fails; the run goes red and the site's own
sync fails on the missing asset.

The posters are shot on `ubuntu-24.04` in Roboto, which the job installs (`fonts-roboto`) before
it shoots. The app sets no UI font of its own, so its text is Tailwind's default `--font-sans`:
`-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', 'Noto Sans', Arial`.
A bare runner has none of the first five, so Chromium fell through to Arial's metric alias,
Liberation Sans. That face has no medium weight, so every `font-medium` label rendered Regular,
and it set the Column Manager's 11px Profile label 17 percent wider than Segoe UI does. Since
kangentic.com's landing page shows the posters with no live frame beside them, that swap was the
app's face as a visitor saw it. Roboto is the first family in the stack a runner can have, so
installing it decides the face, and it ships the medium weight. Measured on the same dialog,
Roboto's labels land within 6 percent of Segoe UI's widths. Noto Sans, the other candidate, ran
up to 9 percent wide and `fonts-noto-core` rendered medium labels Regular. The job's gate compares
`fc-match`'s family exactly, because `fc-match` answers with some font for any name, and
`tests/unit/release-workflow-gates.test.ts` fails when a Tailwind bump drops Roboto from the stack.

No single poster matches every reader's fonts: a reader on Windows or macOS sees Segoe or SF in
the live frame. The live frame renders Roboto on Android and ChromeOS, and the desktop app renders
it on Linux when the font is installed. The terminals fill their panes whatever the font (Live
replay below). A local `npm run demo:posters` on Windows still renders Segoe UI, so a set shot
there is not the release set.

A scoped run for a look at one scene, from PowerShell at the repository root (a relative
`CAPTURE_OUTPUT_ROOT` resolves against the shell's working directory, so run it from the root;
`demo/posters.mjs` always passes an absolute one):

```
$env:CAPTURE_SCENES='board,card-drag'; $env:CAPTURE_THEMES='clay,rust'; $env:CAPTURE_RESOLUTIONS='frame'
$env:CAPTURE_OUTPUT_ROOT='dist/demo-posters'
npx playwright test --project=captures tests/captures/features/scenes.capture.ts
```

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

This is also why the floating scenes open a wider window than the default and why the tiled
scenes have their own recordings (Scenes above): a terminal that is the subject of its figure is
at the same type size as every other frame's. A held terminal's exact scale also moves a little
with the reader's device pixel ratio, because the renderer rounds the cell to device pixels;
`node demo/measure.mjs --geometry` prints the grid every surface fits at scale 1 and 2, and the
manifest's `geometry` names the scale each of its numbers was measured at.

`task-mcp` is the one named exception. The site shows it as the whole app at 56 percent for its MCP
tools tab, where native 12px type is under 7px and the tool names are the point of the figure. So
the scene spells out the `terminal` block with a larger font, sized so the maximized pane fits fewer
columns than the 154-column recording at every display scale, and the seed's hold then lands the
recording on the whole pane at the largest type that carries it. The rest of the frame keeps the
app's own type. No other scene should copy it. The rule above is what keeps the figures one app.

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
two views cannot disagree; the usage dashboard is a seeded, deterministic ninety-day history, and
each period reads its slice on main's own grid (Today by the hour from local midnight, This Week
from Monday, This Month from the 1st), so Today's tiles are This Week's last bar. A drilled day
reads by the hour and a Custom window by the day, or by the week past ninety days. The running
sessions sit in that history under the hour they started, as main's metrics timer writes them, and
the fixture reports their cost as `liveLedgerBaseline`, so the Cost tile's live overlay counts each
session once.
Each archived task carries the stats its last session left (`DEMO_ARCHIVED_SUMMARIES`, what the
Completed Tasks dialog lists), and that session was run for real.
`scripts/capture-demo-archived-runs.mjs` gives each archived task one headless Claude Code run of
its own prompt (`claude -p` with the default template's `<title>: <description>`). Each run is in
acceptEdits, in a throwaway clone of its repo beside the project's scratch clone, trusted the way
the desktop trusts a workspace before a spawn. A run has to start before its task's change.
Upstream had already made three of them (petclinic's Postgres profile, boutique's Go bump and its
move to Artifact Registry), so `manifest.archived.refs` pins the parent of the upstream commit that
made each.

The row is the run. Cost and duration come from the run's own result, which is what the status
line reports. Tokens and tools come from main's own transcript parsers. Churn comes from git over
the clone, untracked files included as `getChurnSummary` counts them. The contoso-web scaffold
commits no lockfile, so the CI task, which generates one for `npm ci`, counts all 3,069 of its
lines. The board's seven runs were on Opus 5, and the row's model is read from the run's history:
the model the main conversation's turns name. The result's `modelUsage` is no guide. Claude Code's
advisor answers on its own model and bills it to the run, and in three of the seven runs it wrote
more than the main conversation, which is how those rows once read Opus 5.5. After a change to how
a run is measured, `node scripts/capture-demo-archived-runs.mjs --remeasure` re-reads every
recorded run from its history without running anything. Every run is Claude Code's, so each
archived task names it as the agent that did the work.

The rows do not reconcile with the usage dashboard. Its series is seeded noise, the Postgres run
alone costs more than the lightest weekday it draws for one project, and the weekday an archive
date lands on moves with the day the frame is opened. One run differs in mode. In acceptEdits,
headless Claude refused the Java 21 task's `.devcontainer/Dockerfile` edit as a sensitive file,
which left one of its three named changes undone. That task runs in bypassPermissions
(`manifest.archived.permissionModes`), standing in for the approval the merged task got.

The runs' transcripts stay on the recording machine, where the Knowledge Graph indexed them
(Knowledge Graph above). The mock answers the archived list per project, as each project's own DB
does on the desktop. So contoso-web's dialog lists its own archive, the history included, and not
every project's. The history runs are on Sonnet 5.5, so their rows name it, beside the board's
seven Opus 5 runs.

### One whole report

An archived task's window is the completed task view, and the report the mock derives for it is
everything one headless run can say: one run, no route, no ledger, no calls, no commits, and a
summary pending (no agent is chosen to write one). The `completed-task` scenes need the rest, so
one task carries a whole record: Set up CI/CD pipeline, the biggest of contoso's board runs and a
top row of the Completed Tasks dialog. It is a scene seed (`__mockTaskReports`), not the dataset.
The dataset holds what the recordings hold, and this report is partly authored.

`tests/captures/helpers/demo-task-report.ts` builds it from rows with main's own
`assembleTaskReport`, so the route, each run's columns, each run's share of its conversation's
cumulative readings, the call outcomes and every total are main's arithmetic. What it takes from
the recorded run:

- The header strip is the Completed Tasks row's own summary. The mock hands the report that
  object when it serves it, so the strip's cost and agent runtime are the row's by construction.
- The four runs are the one run cut at the three points its transcript changes phase: validating
  the workflow it wrote, applying what that found, and its final review pass. Runtimes are the
  spans between those timestamps, tool calls are the calls each phase made, and tokens are each
  phase's turns. Each cost is a literal worked out when the run was split, which shared the run's
  $2.12 by each phase's tokens at Opus's relative prices and rounded it to the cent. They add back
  to the row, which `tests/unit/demo-archived-summaries.test.ts` holds them to.
- Models and tokens is main's ledger over the transcript. Every turn ran on one model, so there
  is one row.
- Files changed is the run clone's git status, most-changed first.

What is authored, because no recording holds it: which column each phase ran in, the second
conversation (one headless run is one conversation), the time between runs, the moves, the two
commits (the run committed nothing), the three background calls (Code Review's Agent evaluation
met once and not met once, then the summary call), and the summary's wording, which says what the
run's own closing message says. The mock moves every time so the Done move lands on the row's
`archived_at`, and `knowledgeGraph.taskSummary` answers with the same written summary, so a map
opened in the same frame agrees with the view.

The two commits being authored, the scaffold repository holds neither, so the view's Changes tab
shows what main's `git:taskChanges` answers for that: the commits are not in this clone. The
scenes seed it as `__mockTaskChanges` (`DEMO_COMPLETED_TASK_CHANGES`), which `demo-task-report.ts`
derives from the history fixture: a commit plan that one day carries those hashes fails the build,
and the seed then has to be their real range. Showing a diff would need the run's file contents,
and its recorded run keeps only counts.

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

Before re-recording the contoso-web api-client session (single or tiled) or the auth task's
accept-edits boot, read Browser guest above, which asks for an `App.tsx` change in the same pass.

Each recording also carries the working tree the agent left behind (`changes`, in the shape
`git.diffFiles` returns), and the dataset seeds it per task through the mock's
`__mockGitDiffByWorktree`, so the Changes panel of any recorded task shows the real diff next to
the real terminal. The `changes` scene selects `server/routes.ts` from the middleware session's
diff. A session cut while the agent was still reading has an empty diff, which is what the app
would show too. The one recording without a `changes` field is the Gemini session, made before
the rig captured diffs and not repeatable until its quota resets; re-run it with
`--only gemini` to fill it in. The Monitor's output peek is each recording's own last displayed
lines (`peek`, read from the rendered headless terminal at record time, with each CLI's footer
and status chrome skipped), never authored. The concurrency cap is the number of running sessions
plus four, so a visitor's drag into an auto-spawn column starts an agent the way it does on the
desktop rather than queueing it. The sample install queues nothing: the one Queued card, in
`session-states`, is a scene patch, and it waits with free slots.

A manifest entry with `tiled` is recorded a second time at the tiled surface's width, under the
file it names: the same prompt run again, in a PTY the size of one pane of a tiled pair. The seed
pairs the two the way it pairs a Command Terminal's two boots, and a window's pane takes whichever
of the two it shows better (`layoutFor` in `demo-dataset.ts`: the type it is shown at, times the
share of the pane its own layout spans), which it then plays like any other recording. It is a
second run, so it says different things: the
session's clock, its card's message trail, its Monitor peeks, and its working-tree diff stay the
single recording's, and only the terminal's bytes are the tiled one's, played from the moment
that clock began; a variant that has already ended by the time its window opens shows its final
frame and stays there. A still frame paints the same: the tiled
recording's own open frame, cut at the moment the single's clock opens at with every row above
its screen (`node scripts/backfill-demo-timelines.mjs` cuts it, since the capture cannot: the
moment is the single recording's; `tiledFrames` in the seed, inline like the open frames, since a
still fetches nothing). A tiled recording without one, or with one cut for another moment, is
refused at build time with that command. Three sessions carry one, the two the
`windows-tiled` scene tiles and the Command Terminal session `command-terminal-tiled` narrows.
The three were made on Claude Code 2.1.275, which asks before a PowerShell command with an
expandable string, so both task runs end at that permission prompt rather than at a summary (the
2.1.270 singles ran to their own end). That is the ending a desktop user gets on that CLI: the
rig seeds trust the way Kangentic does and no permission rule, and pre-allowing `npm *` to
record a cleaner ending would show a session nobody has. The still opens well before the
prompt. Live, the variant plays from the moment the session's clock began, and the clock stays
the single recording's (`sessionDurationMs` in the seed): the middleware variant is 64 seconds
against a session that has already run 38 when the page opens, so a tiled window opens 38
seconds into the variant, plays its last 26 to the prompt, and then holds there while the card
keeps working until the single recording's clock runs out at 128, the way a still of the same
window paints the frame at 38.

The sample install is a Windows machine, because the recording machine is one and so is the
mock's platform: the OS window controls, the Git Bash chip, the agents' PowerShell tool calls,
their backslash paths, and the home directory all agree. Sanitization at record time changes
only the identity: the user becomes `dev`, the home `C:\Users\dev`, the scratch clone the
project's real path under it (`C:\Users\dev\work\contoso-web`), the host name goes, each of them
also when a row wrap or an escape sequence interrupts the literal, and the write is refused if a
marker survives; `tests/unit/demo-fixtures-sanitized.test.ts` is the CI backstop. The recording
account is identity too. Claude's footer links "/rc" to that account's own Remote Control session
wherever the rollout starts the bridge, and the sanitizer drops the link's target, so "/rc" draws
in the same cells and links nowhere. Its advisor notice is kept out by
`CLAUDE_CODE_DISABLE_ADVISOR_TOOL`. Its weekly usage notice has no switch and names the machine's
time zone, so a recording that caught one is re-recorded after the weekly reset. Re-run the
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

### An agent calling Kangentic's MCP tools

One recording shows what no other can: an agent calling `kangentic_*` tools.
`contoso-web-claude-validate-mcp.json` is Claude Code reviewing the Validate request bodies task's
branch on the Code Review column message ("Review the diff on this branch. When it is clean, move
this card on with kangentic_move_task."). It reads the diff, the files, and the tests, then finds
its own card with `kangentic_get_current_task`, reads the board with `kangentic_list_columns` and
`kangentic_list_automations`, checks the next column with `kangentic_get_column_detail`, and moves
the card with `kangentic_move_task`. The recording is cut when the move's result lands
(`stopWhen`). The task is a scene-only row (Scene-only rows above), which only the `task-mcp`
scene adds.

Claude Code 2.1.302 folds consecutive MCP calls into one "Called kangentic 4 times (ctrl+o to
expand)" line in its default view, even while they run, so a default recording shows no tool name
at all. The entry therefore turns on Claude's own Verbose output (`claudeSettings` in the manifest,
`"verbose": true`), the documented display preference a user sets in Claude's `/config`, which
prints each call with its arguments and result. Claude keeps that preference in the user's
`~/.claude/settings.json` and reads it itself beside the `--settings` file Kangentic passes, so a
desktop user who turned it on sees what this recording shows. The rig cannot edit the recording
machine's own file, so the preference rides in the `--settings` file, where Claude reads it the
same way. Verbose also prints the files the agent reads in full, which is why the scene opens late
in the run (`task-mcp` above). `claudeSettings` carries display preferences only, and the rig
refuses one that names a permission.

The rest of the matrix leaves Kangentic's server out, and it cannot be faked: the server runs only
inside the app, and every result it prints comes from that app's board. So the manifest entry is
marked `mcp`, and `scripts/lib/demo-mcp-capture.mjs` does four things before the PTY starts:

- It drives a running `/preview` of this worktree (Allow Unsafe Operations on), never the
  dogfooding app, whose server answers from the recording machine's real projects. It seeds the
  preview with contoso-web as the scene paints it, through the Knowledge Graph capture's seeder in
  its lane placement mode: every task in its own column, each column's agent, the archived history,
  and the recorded task last, so the preview's allocator hands it the ticket the scene's card
  carries. The project is never opened, because opening adds `.kangentic/` to the clone's
  `.gitignore` and the agent would read that in its diff.
- It points the preview's Claude CLI at the repo's mock, so the auto-spawn the move starts in the
  next column costs nothing.
- It makes the task's worktree under the scratch clone, on the task's branch, with `node_modules`
  linked in the way Kangentic links it, and runs the task's own prompt there headless
  (`claude -p`, not recorded), so the review has real work to read.
- It launches Claude the way Kangentic does with its server attached: an `--mcp-config` naming the
  project's URL and the preview's token, and a `--settings` file whose one rule allows
  `mcp__kangentic`, which the desktop adds so its own tools never prompt. Nothing else is allowed.

`--scratch-root` tells the sanitizer the clone the worktree sits in, so the worktree keeps its own
path under the project's home. A re-run removes the project an earlier one registered and seeds a
fresh board.

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
terminal mounts, so a still frame and a first paint fetch nothing. The one exception is a still
that STARTS a terminal: `command-terminal-tiled`'s second window is a spawn, whose boot has no
inline frame, so that scene fetches the boot's final frame and paints it.

### Transcripts

The conversation viewer reads the agent's transcript, which main parses out of the agent's own
history file. The sample install carries one for the middleware session
(`tests/captures/fixtures/demo/transcripts/contoso-web-claude-middleware.json`): the manifest
entry's `transcript` flag asks for it, `scripts/capture-agent-scrollback.js --transcript-out`
writes it at record time from the same transcript match the message trail uses (main's own
parser, so the shape is the desktop's), and `node scripts/backfill-demo-transcripts.mjs` is the
one-time rescue for a recording made before that flag existed. Like the trail it is not
reproducible from the recording: the source lives on the recording machine, so the derived
entries are committed, sanitized whole (tool inputs and results quote absolute paths), and
`tests/unit/demo-transcript-seeded.test.ts` asserts the file is a real conversation from the same
run as the trail. The build emits it under `transcripts/`, its own directory beside
`recordings/`, and the seed answers `transcripts.get` from it when a viewer opens (the viewer's
live poll gets the unchanged short answer), so a still frame still fetches no recording and a
figure of anything but the viewer fetches no transcript. A session without one falls through to
the mock's empty answer, which is what the desktop shows once a history file is gone.

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
| `sess-cw-api-client` | 207 s, a 25 s tail | 7 |
| `sess-cw-middleware` | 128 s | 26 |
| `sess-ob-otel` | 152 s | 25 |
| `sess-ob-currency-a11y` | 35 s | 12 |
| `sess-pc-flaky-tests` | 20 s | 5 |

Which sessions the board shows as WORKING is chosen for this, not at random, and a recording's
`stopReason` decides what it can honestly be. One cut mid-work (`stop-after`) ends on a spinner
with tool calls in flight, so it reads as working and cannot read as anything else. One that ran
to the agent's own end (`idle`) ends on an answer, so it can be either: shown as working it plays
its last stretch and then finishes, which is the transition `loop=1` cycles.

The api-client session's stretch is cut to 25 s so the board's hero flips a card from working to
needs-you inside the first 30 s of every cycle: its last 25 s are the agent's final think, then
its "Done." summary lands. Its tiled run is a second, shorter run (112 s) that ended at a
permission prompt before the single recording's clock opens the session at 182 s, so
`windows-tiled`'s right window paints that prompt while the card still reads working.

That is why the OpenTelemetry session carries the Codex slot. It is 152 seconds of real work with
25 changes, where the Redis TTL session it replaced was 21 seconds with 5, and looped those same
five lines over and over. Redis TTL now sits as needs-you, which its own last frame already showed:
a finished summary above an empty prompt.

`sess-pc-flaky-tests` stays short at 5. It was cut at 20 seconds, so raising the manifest's
`stopAfter` and re-recording is the fix, and that needs Codex credits (exhausted 2026-09-13). Its
terminal is live on any grid either way, played through the page's emulator, and `loop=1` cycles it. When a session's replay reaches the end it finishes as it always does, waits six
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

### Activity stats, for the debug overlay

`sessions.getActivityStats` answers null in the mock, which is the production "session unknown"
path and also the shape of a bridge method that exists and says nothing. Behind the Developer tab's
activity debug overlay that reads as a feature with no data, so the seed fills it
(`activityStatsFor` in `demo-dataset.ts`) for every session that has an activity state.

It is DERIVED, never authored. The state, the reason and its current tool, the signal ages, and the
transition log all come from that session's own seeded `events` and `activity`: the overlay's whole
job is to explain why the engine reports what it reports, and a panel of invented counters beside a
real activity pill would be the one thing on this board that does not agree with itself.

In a live frame the snapshot moves with the session clock, as the engine's would. When the clock
flips a session (its recording reaching the agent's own end, or `loop=1` starting it again), the
snapshot takes the new state, the moment as its last signal, and the step in its transition log,
labelled as the engine labels a finished turn (`event:idle`) and a new one (`event:prompt`). Main
takes the snapshot when it is asked, so the time since the last signal is measured at each of the
overlay's polls and counts up. A still keeps the snapshot the seed built, which is what keeps it the
same frame every time.

Most of the rest has a documented correct value rather than a derived one, which is not a shortcut.
In `compensationCounters`, "in a clean session every watchdog and forced-transition field reads 0",
and no seeded session has had a watchdog fire. `recentPtyChunks` is "empty in production builds
where the recorder is dead-code-eliminated", which is the build this renderer IS. The
background-shell, subagent and internal-agent counters are zero because no seeded session runs any
of them.

One field is a placeholder and is named as one rather than faked. `permissionAwaitedToolId` wants
the tool_use_id a PermissionRequest hook carried, and a recording keeps the agent's BYTES, not its
hook payloads. Null is what the overlay shows for "not captured"; a plausible id would be an
invention.

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

Eleven of the sample install's sixteen sessions carry one, and so does the scene-only session
(Scene-only rows above). The other five show a description, exactly as they would
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
- Pause stops a session where it is: its clock stops, so the card's trail, the Monitor's peek, and
  the finish hold, and the Monitor shows it paused. Resume, from the task window or a drag into an
  auto-spawn column, finds that paused session the way main does. Main clears the task's session
  pointer on a pause and resumes the task's latest paused record, so the demo does not read the
  pointer either; reading only the pointer is what once made Pause then Resume start the task's
  recorded boot from scratch. The paused row is retired and the resumed session is the task's
  only one, as main's respawn leaves it. Its trail and its usage carry over, the usage once the
  resumed agent's first output lands. What its terminal shows depends on where the pause landed:
  - At the recording's end (a session idle or waiting on the user), the terminal plays that
    session's recorded resume boot (`resume-<sessionId>.json`): the real `claude --resume`, the CLI
    reprinting the conversation and stopping at an empty prompt. The reprint covers exactly what
    the frame had shown, so it is honest, and first output lands at the boot's own first byte.
    The `session-resume` scene's live frame resolves its resuming card the same way.
  - Mid-recording (a working session), a real resume would reprint the WHOLE recorded
    conversation, including what the frame had not reached, so the terminal carries the paused
    one's view over instead, as main carries the scrollback: the same recording played through
    the page's emulator to the moment of the pause and frozen there, fitted to whatever grid the
    new terminal has. Pause mid-turn and that frame still holds the
    turn's spinner line, where the desktop's resumed CLI would redraw at its prompt.

  The capture matrix records the resume boots (the `resumes` kind in
  `scripts/capture-demo-sessions.mjs`) for every Claude task session whose conversation is still
  in Claude's history on the recording machine, found by the recording's own trail uuids. Two
  things keep them honest. The rig ends every recording by typing `/exit`, and Claude logs that
  into the conversation, so the driver records against a copy of the history without it (a
  resume would otherwise end on the rig's "Goodbye!"). And a resume appends to that history,
  which the committed trails and transcripts were derived from, so the driver puts the file back
  byte for byte afterwards. Other agents have no resume recording and take the frozen view.
- A new Command Terminal boots the project's default agent with no prompt, which is what the
  desktop starts: `terminal-<projectId>.json` when its window opens alone,
  `terminal-<projectId>-tiled.json` when it opens beside the project's running terminal. When a
  window later tiles or stands alone again, the desktop's PTY resize has the CLI repaint; here
  the session switches to the boot recorded at the other width and repaints from a cleared
  screen at the same point in the boot.
- A note sent from a task's Browser pane goes into the agent the way main sends it, recorded:
  `send-<sessionId>.json` (the manifest's `browserSends`, the `sends` kind in
  `scripts/capture-demo-sessions.mjs`) is the session's conversation resumed, its recorded edits
  put back on the tree, and the note pasted once the reprint goes quiet. The paste is the payload
  main's `buildPromptPayload` writes around the note, naming a screenshot of the guest page the
  driver renders at the pane's size (the entry's `guestSize`, which the demo tier holds to the
  browser scene's pane) into the project's `.kangentic/sessions/` folder (kept out of
  the agent's diff), delivered as `src/main/pty/paste-engine.ts` delivers it: one bracketed paste,
  then Enter as its own write no sooner than a second later, and once more if nothing answers it.
  Claude shows the paste as `[Pasted text #1 +6 lines]` until Enter, then echoes the payload whole
  and reads the screenshot, so the recording is what a desktop Send looks like. A session a scene
  shows finished rests on the frame just before the paste, frozen as a paused session is. That
  frame ships as its own script (`send-frames/<sessionId>-<hash>.js`), which `demo/boot.js` writes
  ahead of the seed only on such a frame, the way a scene-only row's script is written, so a still
  fetches no recording for it and no other frame loads it. Send with exactly the recorded note plays the recording
  on from there: the agent goes to working when it takes the Enter, the card and the Monitor follow
  its reply, and it finishes needs-you. `captureAndSend` resolves when main's would, at the agent's
  first output after the Enter. A choreography's cut takes it back: the seed watches
  `<html data-demo-cut>` and, as the reset starts, repaints the frame the session rested on, sets it
  needs-you, and restores the card and the Monitor. A visitor's own Send stops the choreography,
  so nothing takes it back. Any other note reaches the mock alone, since what the agent would
  answer to it was never recorded. The `browser` scene sends the middleware session's note.
- A workflow's own agent, which the Workflows view's pane opens, shows the recording of that
  workflow's agent planning it (`workflow-<workflowId>.json`, the manifest's `workflowAgents`),
  at its end: the agent saved its plan and ended its turn, so the pane opens idle on its final
  frame. A workflow with no recording keeps the mock's empty session (Workflows above).
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
made at the size of the surface it plays on, from the manifest's `geometry`, which
`node demo/measure.mjs --geometry` measures at the 1600x1000 site frame from the seed's own
resize bookkeeping: a task session at the task window (154 wide), the Command Terminal session at
its single window (154 wide), a session with a `tiled` sibling once more at one pane of a tiled
pair (115 wide), and a Command Terminal boot at both sizes its window can open at (154 wide alone,
115 wide tiled beside an existing terminal), the frame picking one at spawn time, and a workflow's
own agent at the Workflows view's agent pane (84 by 55, with no context bar). A grid moves with
the device scale, since the renderer rounds the cell to device pixels, so each surface in the
manifest names the scale it was measured at: the two single windows at scale 1 (the demo tier's
launch; at the rig's 2x the default window fits 142, and the floating scenes size their window to
the recording instead, see the type-size rule above), the two tiled panes
at scale 2 (the rig's launch, so a tiled figure is at native type there; at scale 1 the pane fits
123 and plays the recording widened to it), and the workflow agent's pane at scale 2 as well (91
wide at scale 1). The spring-petclinic and online-boutique tiled
boots are still at the earlier 124, recorded before the launch was pinned and not re-recordable
until Codex credits return; a recording carries its own grid, so a pane plays those at its own.
Every Command Terminal width above was measured beside the panel's rail when it was fixed at
248px. The rail now opens at 300 and drags from 200 to 400, so the sample install sets it to 248
(`SAMPLE_INSTALL_RAIL_WIDTH_PX` in `demo-dataset.ts`), a width a person can drag it to, and the
panel fit reads the rail from the frame's config. At 300 a tiled pane is a few columns short of
its tiled recording and plays the single one. Recording the tiled Command Terminal runs and boots
again at the default's grid (the Codex boots need Codex credits) lets the sample install take the
default. The rows
follow the agent, because the window's context bar
does: a Claude session's bar carries the account's rate-limit pills and wraps to two rows,
leaving 37, while every other agent's bar is one row, leaving 39 (`rowsByAgent` in the
manifest). The Codex task sessions and spawn boots are still at 37 rows, recorded before that
was measured and not re-recordable until Codex credits return; a 39-row window shows the two
rows above their screen, so that no longer shows (Live replay below). The Gemini session is
still at the rig's 120 by 40, and that does show: the fitter runs its rules, bands and borders
out to a 154-column window, but only the CLI could re-wrap its prose, which stays 120 wide. A
re-run needs Gemini quota. On 2026-09-23 the key on the recording machine answered the CLI's
automatic model choice (Pro) with a free-tier limit of 0, and a pinned `gemini-3-flash`, the model
the card names, with 503 "high demand" on every retry; setting the manifest entry's `model` to
`gemini-3-flash` and running `--only gemini` when Flash answers is the fix. A boot wider than its
window would still be a real miss on the desktop, where an inline TUI's repaint lands on wrapped
rows, which is why the matrix records at the surface's size rather than relying on the fitter.

The grid a visitor's terminal mounts with is theirs, not the recording's. The bottom panel is 15
rows tall, and a task window at the default rect fits 154 by 37 only at the 1600 by 1000 frame
with the sample install's Consolas at a device pixel ratio of 1: the site's take-control dialog on a 1440 by 900
display fits 118 by 26, a Windows display scaled to 125 percent fits 143 by 36, and a machine
without Consolas measures another font. A recording's bytes address rows for its own grid
(Windows ConPTY re-emits even Claude's classic renderer with absolute cursor positions), so
replayed into any other grid they land two frames' text on one row. Main applies one rule to
that on the desktop, and the frame applies the same: bytes replay only into a terminal whose
grid equals the recording's.

Every other grid is FILLED, never letterboxed. This demo once held the recording at its own grid
inside a bigger pane, and what that left empty was on nearly every surface at some display
scale: 56px beside and 23px below every card window at 125 percent, 314px below the Browser
scene's terminal at 100, 60px beside a tiled window in the posters' face. So a terminal always
takes a grid that fills its pane (`displayFor` in the seed), and the recording plays into that
grid through the page's own emulator (below):

- A pane at least the recording's width, or a column or two short of it (`NEAR_MISS_COLUMNS`),
  keeps the configured type at its own grid, and the recording is widened or cut to it. Smaller
  type is not worth a column or two: at 100 percent it would cost a sixth of the cell, since xterm
  floors the cell to device pixels. That is the default task window on a desktop browser at 100
  percent, whose 8px scrollbar gutter leaves it 153 columns for a 154-column recording. The seed
  once held that pane and the conform declined, so the terminal kept 153 columns while the bytes
  it was sent addressed 154: every padded row wrapped into a blank one, and Copilot's scrollbar
  landed in column zero.
- A pane further short is HELD at a smaller type. The seed answers the terminal's resize the way
  main answers one it refuses, with the grid it holds (`SessionResizeResult.held`), and the
  terminal conforms (`conformToHeldGrid` in `useTerminal`), scaling its font down. The held grid is
  the one the WHOLE pane takes at the largest type that carries the recording's columns (or all but
  a column or two of them, a near miss at that size as at the configured one), predicted from the
  conform's own rule (it lands on the largest quarter-pixel size at which the grid fits) and from
  the cell xterm rounds that size to (`terminalDeviceCell`). What is left over is under a cell or
  two each way. A card window at 125 percent is held at 163 by 38 for a 154-column recording, at
  seven-eighths of the type.
- Below `HOLD_MIN_SCALE` (0.6) the type would be unreadable, so the pane keeps the configured type
  and the recording is cut at its edge.
- Rows never set the type. A shorter pane shows the bottom of the screen, as a terminal scrolled to
  the bottom does, and a taller one shows the rows above it.

The conform used to land short of that largest size. It proposes a font from a linear model of the
cell and stepped only down from there, but a cell is not linear: several quarter-pixel sizes draw
the same device-pixel width, and Courier New's height at 11 px is a whole pixel under 12 scaled
down. So it could stop a size below the largest that fits and letterbox rows the pane had room
for: three empty rows under a tiled window in the posters' face. It now steps back up while the
grid still fits, never past the configured size, and the desktop's own hold (a phone streaming a
session) gets the same. A hold the terminal never reports back within two seconds was declined,
and the seed shows that pane at the configured type instead. The demo tier asserts the invariant
rather than the path, since the path rides on the platform's font: every terminal fills its pane,
and a terminal handed bytes is on its recording's grid.

The conform only ever scales DOWN (`CONFORM_MAX_SCALE` in `useTerminal` is 1), so a held terminal
is never in bigger type than the panel beside it. Two font sizes on one screen was the first
thing a live look caught; a pane wider than a recording keeps the configured type and the
recording is widened to it instead. A held terminal keeps probing with the grid
it would fit on its own, so a Command Terminal that tiles still switches to the boot recorded at
the tiled width, and the desktop's own hold (a phone streaming the session) ends the moment
main accepts the probe. A real window resize repaints; the terminal reporting the grid it was
just held at does not, being the conform landing rather than the window moving. Reading that
report as a resize repaints on every conform, which put a whole frame into a terminal whose
session was already at its recording's end and should have received nothing.

A terminal on any grid but its recording's is fed by the page's OWN emulator
(`demo/replay-emulator.ts`, a 4 KB chunk fetched the first time one mounts, over the renderer's
own xterm and its Unicode 11 widths). The recording's bytes are written into it at the RECORDED
grid on the session's clock, and after each write the visitor's terminal is repainted from what
it shows, as a frame fitted to the visitor's grid. It is what main does on the desktop for a PTY
whose grid the renderer does not share, at the stream's own pace: a spinner turns and a reply
streams as they do on the bytes path, where the `frameTimeline` each recording carries sampled
four screens a second (the fixtures keep it; the build no longer ships it). Parsing is cheap: the
4 MB Gemini stream parses in about 50 ms, and a frame serializes in about 1 ms. Each frame carries
the rows above the screen that a taller grid shows, and the cursor shown or hidden as the CLI
left it. The first paint clears the terminal and writes the screen with 500 rows above it to
scroll back through. After that a repaint builds on the last, the way a stream does: the rows that
scrolled up since are scrolled into the terminal's own scrollback, and the screen is redrawn in
place, so a visitor who scrolls up while an agent streams stays where they are. A new grid, the
alternate screen, or the CLI clearing its own history takes a full paint again. A session no
terminal shows keeps writing and skips the repaint (`sessions.setMounted`). If the chunk does not
load, the terminal shows the recorded frame for the moment it opens at, and the page says why.

A frame is PHYSICAL rows (`scripts/lib/demo-frame-serializer.js`): one row per recorded row, each
self-contained in its styling, joined with line breaks, behind the alternate-screen switch when
the CLI was on it, and ending in one absolute cursor position. It is not the serialize addon's
output, which joins a row onto the row before it wherever the terminal had wrapped and relies on
the same width to wrap it again: on a grid 20 columns wider every continuation spilled its first
20 characters onto the row above and started its own row 20 characters in, which read as a cut
left edge and a phantom sidebar (task #673). The final frame and the open frame are serialized
the same way, with every row above the screen, so a still or an idle session scrolls through its
whole history and fills a taller pane without the emulator.

The alternative was recording each surface at its own grid, and it does not work. The panel is 15
rows against a recording's 37, and no font size reconciles them: 154 columns needs about 16 px
type, at which 37 rows would want a panel taller than the whole frame. A grid also moves with the
display scale (the panel is 219 columns at 100 percent and 202 at 200), so a per-surface recording
would fit one machine and no other. Frames have neither problem and cost no capture run.

A geometry change also does not END the session. It does not finish an agent's turn on the
desktop, where main routes that session to its parsed frame and the agent goes on working, so it
must not here: a session the board shows as working keeps the clock the seed started, along with
its card, its sidebar count and its Monitor peeks. Only a session already at its end paints its
end. The emulator runs on the same clock the bytes path does (`frameScrollback` beside
`liveScrollback`): a spawn plays its boot from the moment it started, rather than jumping to the
boot's end and reading as finished, and a window resized to another grid keeps its emulator and
is repainted for the new grid, rather than painting the recording's end and stopping the card and
the Monitor where they stood.

The applier (`fitFrameToGrid` in `demo-dataset.ts`) fits each frame to the mounted grid row by
row, and the serializer already dropped the plain spaces ConPTY pads every row with. A row wider
than the grid is CUT at the edge, never left to wrap: the CLI would have re-laid its prose out at
this width, and a wrap mid-word is what nothing would draw. Before the cut, a cursor-forward gap
ahead of a right-aligned tail is shrunk so the tail lands at the edge (Claude's "/rc" at the
footer's edge, Copilot's timing beside its border). A row that ENDS in a vertical edge glyph (a
box's right side, corner or tee, or Copilot's scrollbar, U+2503) keeps that glyph at the edge in
the style it was drawn in, and the rest of the row is fitted one column narrower: a plain cut
dropped the glyph from rows padded with spaces up to it and kept it on rows a gap pulled in,
which broke Copilot's scrollbar into segments one column short.

A grid WIDER than the recording gets what the CLI drew to its own edge drawn to the new one
(`widenRow`), the way the desktop's TUI would lay it out at that width: a right-hand border or
scrollbar moves to the new last column and the gap before it takes the extra cells, so a box
widens and its left side stays put; a background band (an erase to the edge, Codex's and
Copilot's input bands, Claude's diff lines seven columns short of it) runs on; a horizontal rule
runs on, and one right before a corner runs on to the corner; a panel's styled padding (OpenCode)
runs on; and right-aligned text after a gap of four cells or more moves out with the gap
(Claude's "/rc", Copilot's model and session usage). That text may be several styled words
(Claude's "◐ medium · /effort" footer, a subagent's timing), and it may sit a cell from a border
or scrollbar (Copilot's "10s ┃"), where it stays against the edge. It must end inside the CLI's
right padding (Claude keeps two cells, Copilot one) and take at most half the row. A row that runs
to the edge itself, a tail cut to fit with an ellipsis, and a tail that is most of its row (Codex's
search hits, whose code follows an indentation gap) are content the CLI filled the width with, so
they stay as recorded. A box drawn inside the padding widens like one drawn to the edge (Copilot's
welcome box, two cells short). Each applies only to a row that reached the
recorded edge. A row that stopped short of it is prose or a short rule and stays as drawn, one-cell
gaps are never grown (a box border and a sentence would part), and a vertical bar is never
extended sideways, which is what the striped block in #673 was (Copilot's right border, grown 20
wide by a rule that stretched any box-drawing glyph). The bottom panel is the widest case, 219
columns against 154. A TALLER grid on the alternate screen gets rows inserted where the TUI would
grow (`altRowsInsertion`): below the last of the rows that run down a right-hand scrollbar
(Copilot), each new row that scrollbar alone, or below the last blank row in the lower half
(OpenCode, above its input), so the input and the footer stay at the bottom. A normal-screen frame
needs nothing there: it carries the rows above its screen. `demo-frame-fit.test.ts` runs every
recording 1, 9 and 64 columns wider and holds each to drawing, at the new last column, whatever
it drew at its own. OpenCode's sidebar is the one layout the fitter only approximates: it stays
where it was drawn with its background run on to the edge, where OpenCode itself would dock it
right. Widths are
counted in cells from the app's own Unicode 11 table, inlined into the seed at build time
(`buildCellWidthTable`), and autowrap is off while the rows are written, so a cell the two still
disagree on overwrites the last column instead of wrapping. The cursor is recomputed for the
mounted row count: a 37-row frame in the 15-row panel scrolls 22 rows up, and the cursor's row
moves with them. Prose keeps its recorded wrap points, because the CLI chose them at that width
and wrote them into the bytes as line breaks; only the CLI could re-wrap that, which is why a
pane more than a column or two short of the recording is held at a smaller type rather than cut.
A still frame goes through the same applier: the renderer resizes before it asks for the
scrollback, so the mounted grid is known (the held one when there is a hold), and the frame a
still paints (a working session's opening frame, an idle session's end) is fitted to it. Below the
hold floor each row is cut at the edge rather than wrapped, which is what a `state=` blob that
narrows a Changes pane to a quarter of the window gets.

One thing the frame path does not do is make text bigger on a display scaled to 200 percent.
That report (kangentic.com #76) came from a capture at an emulated device pixel ratio of 2, and
it is the capture, not the frame: under Playwright's `deviceScaleFactor` the `device-pixel-content-box`
a `ResizeObserver` reports is the CSS size, and xterm's WebGL addon, which trusts that observer
for its canvas backing store, draws 2x glyphs into a 1x buffer. A real 2x display reports real
device pixels, and so does Chromium when the scale is forced on the browser rather than only
emulated on the context: the rig launches with `--force-device-scale-factor=2` on top of the
context's `deviceScaleFactor` (`launchCaptureBrowser` in `tests/captures/helpers/capture-page.ts`),
the forced scale reaches the compositor, the observer reports 3200 by 2000 device pixels for the
1600 by 1000 frame, and the WebGL renderer draws each glyph into a buffer of the right size. That
is the recipe every 2x poster is shot with, and it is the only one that is: `--disable-webgl` puts
the terminals on the DOM renderer, which sizes right but is not what a reader's frame draws, and
an emulated scale alone is the bug above. WebGL stays on.

## What the page ships, and what it costs

Measured with `npm run demo:measure`, headless Chromium, a plain static server on localhost, warm
disk. The weight, cold boot and frames-per-page tables are from the build of 2026-10-20, after
lucide's icon map left the startup path. The heap table is from that build and three before it,
measured back to back on one machine.

### Before first paint (gzipped)

| File | Raw | Gzip |
|---|---|---|
| index (the renderer) | 1062 KB | 300 KB |
| WorkflowDialogs chunk | 235 KB | 67 KB |
| demo-seed.js (the sample install: opening and final frames, tiled frames, diffs, peek timelines, message trails, the cell-width table) | 1006 KB | 152 KB |
| xterm + xterm-unicode11 | 460 KB | 119 KB |
| Pill, shared, datetime, useValuePulse, PrLink and icon-registry chunks | 233 KB | 75 KB |
| nine one-icon chunks (zap, search, plus, chevron-down and the rest, below) | 16 KB | 7 KB |
| react-vendor | 215 KB | 66 KB |
| KebabMenu chunk | 153 KB | 45 KB |
| mock-electron-api.js (the bridge) | 131 KB | 32 KB |
| demo-boot.js + demo-scenes.js + demo-webview.js | 165 KB | 37 KB |
| index.css + xterm.css + WorkflowDialogs.css | 144 KB | 23 KB |
| rolldown-runtime + preload-helper | 2 KB | 1 KB |
| **Eager total** | | **925 KB** |

The five classic scripts `demo/vite.config.mts` injects ahead of the bundle, and each scene-only
row's script, are minified at build time (`minifyClassicScript`). Vite never sees them, so they
used to ship as written: `demo-boot.js` and the mock were mostly comments, and the seed kept its
applier's indentation and comments. On the same tree, minifying took the five from 320 to 219 KB
gzipped, about 9% of everything a frame loads before first paint: `demo-boot.js` from 18 to 6 KB,
the mock from 82 to 32 KB, the seed from 188 to 151 KB, and the scenes and the shim a KB each.
The demo tier minifies each shipped script again and fails if that gains more than 2%, so a
script added to the head unminified fails there. This is download size only. The JS heap after a
forced GC, which is what the site's figure budget is about, did not move: one board frame is 16.3
MB and four are 38.0 MB, minified or not (same-origin frames on one page, measured back to back).
Those two numbers match CDP's V8-only `JSHeapUsedSize` with Playwright's own 0.3 MB scripts in it,
so that is most likely how they were read; the table in JS heap after a forced GC, below, is the
read to compare against. A script the page loads over the network keeps its source outside the heap
that number reads.

lucide-react's whole icon map was the largest single cost on that list, and it no longer loads at
startup. A column's icon (and a command shortcut's) is persisted as a kebab-case name, so any glyph
can come back by name, which is why the map was imported whole. `src/renderer/utils/icon-registry.ts`
now resolves the 13 icons the default board, the shortcut presets and the sample install name
from named imports, and loads the map (`icon-catalog-<hash>.js`, 563 KB raw, 150 KB gzipped)
only when the icon picker opens or a column names an icon outside that set. `loadBoard` waits for
it before it paints such a column, so a project switch still paints every icon on its first frame.
No scene opens the picker or names another icon, and the demo tier holds a board frame and
`task-mcp` to no request for the chunk. The WorkflowDialogs chunk it lived in went from 819 to 235
KB raw and the eager total from 1,063 to 925 KB gzipped, both builds back to back. The split left
the icon-registry chunk and nine one-icon chunks that the startup path shares with the map, each
under 14 KB, which add ten requests to a frame's boot (Cold boot per scene, below) and no heap
anyone can measure. The desktop
renderer gets the same split; `assertVendorChunksLazy` in `scripts/build.js` fails a build that
puts the map back on the startup path.

The whole `dist/demo/assets` is 18.1 MB raw, almost all of it monaco's lazy language and worker
chunks, which only load when a Changes panel opens (the `changes` scene adds 6 requests).
`demo-seed.js` carries each session's terminal frame and the working-tree diff it left behind;
it is the one eager file that grows with the dataset. It was 112 KB gzipped when it held 16
sessions and 10 diffs, and 172 KB on the build of 2026-10-16, both unminified; the figures below
are unminified too. It grew 14 KB gzipped when working sessions gained their opening frame as well as their
last one, which is what lets a still and the captures show the moment the live replay starts
from. It grew 3 KB more when they gained their peek timelines, which is what makes the Monitor
move without a terminal open. It grew 7 KB more for the agent message trails, which are what the
board cards themselves say under the default Card Preview. It grew 4 KB more when the frames
became physical rows and the seed took on the cell-width table the applier clips with. It grew
17 KB more for the tiled frames of the three sessions with a tiled recording (a final frame and
a working session's opening frame each), which is what lets a still of a tiled window paint the
right recording without a fetch. It grew about 50 KB more (156 to 207 KB by the same gzip, built
from the commit before and after) for the Knowledge Graph's three maps and the 177 older archived
tasks whose conversations make them up, with each task's run summary. The maps alone were about
30 KB of that, and no board frame draws them, so they left the seed. The build emits them as
`graph/knowledge-graph-<hash>.json` (147 KB raw, 31 KB gzipped), and the seed fetches that file
the first time a frame opens the graph (`seededKnowledgeGraph`), as the conversation viewer
fetches a transcript. The seed went from 207 to 175 KB by the same gzip, and eight board frames on
one page from 74 to 66 MB of heap (`demo:measure`, both builds on one machine, run back to back).
Ready times moved by less than their run-to-run noise. `tests/demo/static-demo.spec.ts` holds a
board frame to no graph request and the graph scene to exactly one. The scene-only session
(Scene-only rows above) used to add about 18 KB gzipped (90 KB raw) to the seed: its final and
opening frames, its diff, its peek timeline and its trail. Only `task-mcp` shows it, so it left the
seed for its own script, `scene-rows/task-cw-validate-<hash>.js` (91 KB raw, 17 KB gzipped), which
only a frame naming the row loads. The seed went from 1,169 to 1,080 KB raw and from 190 to 172 KB
gzipped (level 9, both builds on one machine, run back to back), and `demo-boot.js` grew half a KB
gzipped to write the script. The same test holds a board frame to no row-script request and
`task-mcp` to exactly one.
The 44 recordings under `recordings/` (six of them tiled siblings, five of them resume boots) are
17.3 MB raw and 543 KB gzipped in total, fetched one at a time as terminals mount, so none of it
is on the boot path. The resume boots are 204 KB raw and 29 KB gzipped of that, and one is fetched
only when a visitor resumes a session paused at its recording's end. The MCP recording, added
later for the `task-mcp` scene, makes 45 and adds 292 KB raw and 32 KB gzipped, fetched only by a
frame that mounts its terminal. The workflow agent's recording, for `workflow-draft`, makes 46 and
adds 236 KB raw and 32 KB gzipped, fetched only when its pane opens. The browser send makes 47 and
adds 297 KB raw and 30 KB gzipped, fetched when the `browser` scene's terminal mounts on the frame
it rests on. That frame is a 42 KB script of its own, which only a frame showing the session
finished loads; inline it took the seed from 1,030 to 1,072 KB raw and cost every frame on a page
about 0.07 MB of heap. Each recording carries its timed
stream, final frame and grid. They were 38.3 MB and 832 KB while each also shipped its frame
timeline, which the page's emulator made redundant (Live replay); the fixtures keep it. The
largest single file is the Codex OpenTelemetry session at 70 KB gzipped. The emulator is a 4 KB
chunk that shares the renderer's xterm, fetched the first time a terminal mounts on a grid other
than its recording's. The choreography player is a 9 KB chunk (4 KB gzipped), fetched only by a
frame that plays a choreography: a live frame under `loop=1`, or a still with a pose. The one transcript under `transcripts/` is 32 KB raw and 8 KB gzipped,
fetched only when a conversation viewer opens.

### JS heap after a forced GC

kangentic.com budgets its figures by the JS heap a page holds after a forced GC, not by bytes, and
caps them per page by it. `node demo/measure.mjs --heap` reads that number the way the site does:

- Frames are same-origin iframes on one host page, laid out at the site's 1600 by 1000 and scaled
  into an 800 by 500 cell (the scale changes nothing measured). Frames on one page share a renderer
  process and one V8 isolate, so the page's number is the read, never a sum of frames.
- A still frame is read 1 s after ready, a looping one 15 s after, the site's own wait.
- The page's own `gc()` runs twice (Chromium launched with `--js-flags=--expose-gc`), and 800 ms
  later `Runtime.getHeapUsage` gives the V8 heap and the array buffers held outside it. Their sum
  is what `performance.memory.usedJSHeapSize` reads with `--enable-precise-memory-info`, the site's
  number.
- Each cell is the median of three fresh browser contexts, with the builds interleaved run by run,
  so a drift in the machine lands on every build alike.

`demo/heap.mjs` holds the read, and the guard below uses the same one. Four builds, back to back on
2026-10-20, in MB (V8 heap + array buffers). Before is the build of 2026-10-19 (minified head
scripts); after is the same tree with lucide's icon map off the startup path.

| Case | v0.46.0 | v0.47.0 | Before | After |
|---|---|---|---|---|
| board, still, 1 frame | 21.1 (15.7 + 5.5) | 21.4 (15.8 + 5.6) | 21.1 (15.8 + 5.3) | 18.3 (13.6 + 4.7) |
| board, still, 4 frames | 44.5 | 44.8 | 44.5 | 39.4 |
| board, still, 1 frame at 800x500 | 21.1 | 21.3 | 21.0 | 18.3 |
| board, still, 4 frames at 800x500 | 44.1 | 44.3 | 44.1 | 38.9 |
| board, looping, 1 frame | 27.3 (21.4 + 5.9) | 27.7 (21.6 + 6.1) | 27.3 (21.6 + 5.7) | 24.5 (19.3 + 5.2) |
| board, looping, 4 frames | 68.6 | 69.8 | 69.5 | 64.3 |
| task-mcp, looping | not in the build | 38.6 (25.5 + 13.0) | 38.4 (25.7 + 12.7) | 35.5 (23.4 + 12.1) |
| changes, looping | 46.9 (35.7 + 11.2) | 49.1 (37.7 + 11.4) | 49.0 (38.0 + 11.0) | 46.2 (35.7 + 10.5) |

v0.47.0 did not double the heap. Held to one scene, one mode and one harness, it added 0.3 MB to a
still board frame, 0.4 MB to a looping one, 1.2 MB to four looping boards and 2.2 MB to a looping
`changes` frame. The `changes` growth is its new choreography running: a heap snapshot of one frame
against v0.46.0 puts it in compiled code (machine code up 0.8 MB, with its feedback) and style data,
and taking the player's `:hover` mirror out of a scratch build moved nothing (45.8 against 46.0 MB).
`task-mcp` is new in v0.47.0 and holds 11 MB more than a looping board. 4.1 MB of that is V8 heap,
mostly compiled code for the maximized task window, its header and its context bar. 6.9 MB is array
buffers held by its larger terminal (the snapshot counts 1,184 buffers against the board's 94).
Cutting the replay emulator's 5,000-row scrollback to 200 saved 1.4 MB of that and nothing on a
board, so it stays.

The site's 17.4 to 36 MB for the landing hero compares two different reads, not two apps. On
production on 2026-10-20 the landing page alone, with the demo frame's origin blocked, held 12.1 MB,
and with the hero booted 36.2 MB, so the hero frame is the other 24.1 MB, about what a looping board
frame holds on any of the three builds. This harness reads a v0.46.0 board frame alone at 21.1 MB
still and 27.3 MB looping, so 17.4 MB is below any full read of a page that holds one. It does match
the V8 heap alone of a looping v0.46.0 board frame after CDP's collection (17.4 MB, with its 5.8 MB
of array buffers left out), which suggests the 2026-10-16 number was a narrower read. It cannot be
reproduced from here. The "about 8 MB a frame" from the same day is the cost of a frame after the
first. Frames on one page share compiled code, so a page's first board frame holds 18.3 MB and each
one after it 7.0 MB (Frames per page, below).

Three things in a harness move this number with the app standing still:

- `performance.memory.usedJSHeapSize` counts ArrayBuffer backing stores (xterm's buffer lines, a
  WebGL glyph atlas) and CDP's `Performance.getMetrics` `JSHeapUsedSize` does not. On one build a
  still board frame reads 21.0 MB by the first and 15.8 MB by the second, `task-mcp` 38.1 against
  25.5.
- CDP's `HeapProfiler.collectGarbage` runs a memory-reducing collection a tab never sees. On a
  looping board frame it read 4.2 MB less V8 heap than the page's own `gc()` (14.7 against 18.9
  MB). A still frame reads the same either way.
- Playwright's `waitForFunction`, `expect(locator)` and `evaluateAll` inject its InjectedScript into
  each world of the page they touch, a 0.31 MB source string the heap then holds once per world.
  That is the string #848 found held twice, starting `(() => { const module = {}; var __commonJS`;
  it was never the demo's. The harness polls a host-side message listener with `page.evaluate`,
  which loads only Playwright's small utility script.

The cut is lucide's whole icon map (Before first paint, above). Every case lost 2.7 to 5.2 MB:
2.8 MB on a page's first board frame and 0.8 MB on each frame after it, since frames on a page share
compiled code.

`tests/demo/heap-budget.spec.ts` holds one board frame to 21 MB still and 29 MB looping, through
`demo/heap.mjs`. That is about 15 percent over what it reads: 18.3 and 24.5 MB here, and 18.2 and
23.9 to 24.4 MB on Ubuntu 24.04 with the same Chromium build (Playwright 1.63's headless shell,
run under WSL, three runs each). Repeated reads agree to 0.1 MB still and 0.6 MB looping, so the
headroom is for creep rather than noise, and the `demo` job logs CI's own reading on every run. It
also fails when the frame's terminal draws without WebGL: headless Chromium has WebGL on both
platforms, as a visitor's browser does, and a runner without it would measure the DOM renderer,
which no visitor's tab runs. The icon map coming back reads 21.1 MB, right at the still budget, so
the tier also holds a board frame to no request for its chunk, which catches it exactly.

To find what grew, `node demo/measure.mjs --heap-snapshot=<scene>[,loop]` writes one frame's heap
snapshot and prints self size by node type and by constructor, with the largest strings. Given two
builds through `--dist`, it prints the groups that moved most between them. A snapshot also counts
script source and other external strings that the heap read does not, so confirm a candidate it
names by taking it out of a scratch build and reading again, as the emulator and `:hover` checks
above were.

### Cold boot per scene

| Scene | Requests | Off-origin | First contentful paint | Ready |
|---|---|---|---|---|
| board | 32 | 0 | 224 ms | 303 ms |
| task | 32 | 0 | 224 ms | 355 ms |
| changes | 40 | 0 | 80 ms | 510 ms |
| monitor | 38 | 0 | (paint inside the veil) | 380 ms |

Each scene makes ten more requests than the build of 2026-10-19 (22 on board), the icon-registry
chunk and the nine one-icon chunks the icon map's split left (Before first paint, above). Ready
moved by less than its run-to-run noise (board 330 against 303 ms, the two builds back to back).

Zero off-origin requests on every scene: the renderer's Sentry SDK has no network path of its
own and never initializes under the mock, analytics go through the bridge the mock stubs, and the
build references nothing outside its own origin. The `demo` smoke tier asserts this on every run,
so the site's privacy page needs no line for the frame.

### Frames per page

Board frames, still, at 1600 by 1000, with the heap read as in JS heap after a forced GC above.

| Frames | All ready | Script time | JS heap after GC |
|---|---|---|---|
| 1 | 313 ms | 168 ms | 18.3 MB |
| 4 | 774 ms | 385 ms | 39.4 MB |
| 8 | 1546 ms | 731 ms | 67.5 MB |

The bundle downloads once and caches; each frame parses and executes it again for roughly 70 ms of
script. Frames on one page share compiled code, so the first frame holds 18.3 MB and each one after
it 7.0 MB. Eight live frames on one docs page cost about 1.5 seconds on a desktop machine, which is
the number the docs-visuals decision (#632, site #78 and #79) was waiting for. This does not decide
live frames against stills; it says the ceiling is well above what a docs page would use. The same
table on the build of 2026-10-19 read 21.1, 44.5 and 75.7 MB.

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
| Task-detail Browser pane | The pane is the real renderer; its `<webview>` is stood in for by `demo/webview-shim.js`, an iframe onto a bundled page with the project's own data at its dev URL (Browser guest below). Inspect finds nothing and history is empty. Send plays the matrix's recording of a note going into the session when the note is the one it recorded and the session is at rest on it (Live replay above); any other note reaches no agent. |
| Folder pill, PR links, external links | Inert: `shell.openPath` and `openExternal` are logged by the mock. |
| Pop-out (Monitor, Changes, Stats) | Inert: the in-app surface stays where it is. |
| Dictation | The whole renderer pipeline runs on a press, over a silent microphone `demo/boot.js` supplies (the mic is never requested), and the chip shows its live state over a terminal or a text field. What it hears is one recorded utterance, typed into a focused text field as it streams; a terminal shows nothing typed (Dictation below). |
| Display language | Restart now switches the frame in place, since a page cannot restart: the picked catalog loads and every label follows (Display language above). |
| Updater | Silent: no update is ever "downloaded". |

Two things stay out of reach of a live frame: the Browser pane's REAL guest (a page the agent is driving) and a dictated transcript landing in the terminal.

## Observations for the docs-visuals decision (#632)

- **Declarative reach, verified against the static build.** Everything reachable from config or
  a row in the desktop app is reachable here with no gesture: `workspaceByProject` restores a
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
  measurement runs without a miss. The boot steps still carry no timing. Motion came later and
  separately (Choreography and timelines below): pacing there is data on a step, every effect a
  step depends on is still a selector waited for, and it plays only under `loop=1`.
- **Per-frame boot cost** is in the table above: about 70 ms of script and 7 MB of heap per frame
  after the first, a second and a half for eight.

## Layout of `dist/demo/`

```
index.html                       the entry, five classic scripts then the module bundle
stage.html                       the fixed-size host a direct visit lands on
scenes.json                      the scene list the site reads at build time: name, reach, alt, version
demo-scenes-<hash>.js            the registry, the app version, the config shape a state= blob is checked against, the recordings and transcripts index, the guest pages
demo-boot-<hash>.js              demo/boot.js verbatim
demo-webview-<hash>.js           demo/webview-shim.js verbatim: the iframe standing in for <webview>
mock-electron-api-<hash>.js      tests/ui/mock-electron-api.js verbatim
demo-seed-<hash>.js              the sample install, final frames, diffs, and history embedded
recordings/<name>-<hash>.json    one timed stream per recording, fetched when a terminal mounts
transcripts/<session>-<hash>.json  the agent transcript behind a session, fetched when a conversation viewer opens
graph/knowledge-graph-<hash>.json  the Knowledge Graph's three maps, fetched when a frame first opens the graph
scene-rows/<task>-<hash>.js      a scene-only row's recorded sessions, written in by demo-boot only on a frame that names the row
send-frames/<session>-<hash>.js  the frame a recorded Send's session rests on, written in by demo-boot only on a frame that shows it finished
guest/<name>-<hash>.html         the page a project's dev URL shows in the Browser pane
assets/                          the renderer's hashed chunks and stylesheets, monaco's lazy chunks and workers
```

Every file but the two entry pages and `scenes.json` carries the first eight hex digits of its
content's SHA-256, the way Vite names its own chunks. GitHub Pages serves everything with a ten-minute cache, and a
visitor who opens the page across a release must never pair a new seed with an old recording:
a recording replays only into the grid its seed describes, and a stale one lands two frames'
text on one row. With the hash in the name a changed file is a new URL, an unchanged one is
still cached, and `index.html` is the only file whose cached copy can lag, for ten minutes, as a
whole and self-consistent page.

`npm run demo:posters` writes beside this tree, never into it: the shots go to
`dist/demo-posters/scenes/` and the zip to `dist/demo-posters-<version>.zip`, so a poster run
leaves the deployable build untouched and `build:demo` (which empties only `dist/demo/`) leaves
the last poster set where it was.
