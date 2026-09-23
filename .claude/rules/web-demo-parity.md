---
paths:
  - src/shared/types.ts
  - src/preload/**
  - tests/ui/mock-electron-api.js
  - demo/**
  - tests/captures/**
  - tests/demo/**
---

# Rule: the web build is the real renderer, kept at parity by machinery, not by hand

`npm run build:demo` builds the desktop renderer for a plain browser (`dist/demo/`), where the
site and the docs embed it to show the actual app rather than a screenshot or a recreation. It is
the same `src/renderer` bundle the Electron build ships, running against the in-browser mock of
the bridge (`tests/ui/mock-electron-api.js`) and seeded with the sample install
(`tests/captures/helpers/demo-dataset.ts`). Parity with the desktop app is therefore a property of
three things staying in step, and each is enforced rather than remembered.

## The rule

- **Every method on `ElectronAPI` has a mock implementation.** A bridge method the mock lacks is
  a silent runtime failure in the web build. Add the mock method in the same change that adds the
  interface member. An OPTIONAL member (`foo?:`) is exempt from the parity test by construction,
  so the skip list is pinned: adding one is a decision, not a side effect. That list grew silently
  once, which is how the message trail reached the demo with no mock data behind it.
- **Demo behaviour lives outside `src/renderer`.** The URL contract, the config overrides, the
  still and embed styles, and the scene applier are `demo/boot.js` and the scene registry
  (`tests/captures/scenes.ts`); the fixed-size host a direct visit lands on is `demo/stage.html`.
  Renderer code never reads `location`, never checks a demo flag,
  and never branches on being embedded. The one renderer concession is a `data-testid` on the
  window-controls cluster so the demo can hide it by selector.
- **A scene is data.** Config overrides, task-row patches, session activity, `__mock*` seeds, and
  at most a short list of boot steps: a click, a typed query, or a held hotkey, each a state and
  none a choreography (no timing, no narration). No code travels through a scene or a `state=`
  URL. A scene the demo cannot build (`reach: 'driver'`) is refused loudly, never approximated;
  its gesture (a `hover`, a `contextmenu`, a `drag` that may `hold`) is data too, and only the
  capture rig plays it.
- **A surface Electron alone provides is mocked as a surface, never faked as content.** The
  `<webview>` tag has an iframe standing in for it (`demo/webview-shim.js`), loading a bundled
  page at the project's dev URL whose data is the project's own and nothing invented. Its
  presentation, the layout and the styling, is the one authored part: the scaffold's
  `src/App.tsx` renders a bare heading and list, and rebuilding it would invalidate the
  recordings that edit that file (`demo/README.md`, Browser guest). The microphone is a silent
  stream so dictation's real pipeline runs, and no transcript is authored because the desktop draws
  the words through the CLI's echo. Git history is a real repository built from a commit plan and
  read with git. The line is the same one the terminal rule draws: mock the bridge, record or
  derive the content, and where content cannot be honest, show the surface without it. Every entry carries the three fields that leave this repo: `alt`, the
  reader-facing text a docs figure carries; `ready`, the selector the frame is built at; and an
  optional `focus`, the element whose rect the ready message reports. The registry has two
  consumers by construction (`demo/boot.js` at `view=`, the rig at
  `tests/captures/features/scenes.capture.ts` against the BUILT demo) and the rig keeps no
  applier of its own, so the two cannot describe one state two ways.
- **The site learns the list from the build, never from a copy.** The build emits `scenes.json`
  unhashed beside `index.html`, generated from `SCENES`: name, reach, alt, description, and the
  app version. A vendored or packaged copy can lag what is deployed; a URL cannot. The poster set
  the site's figures fall back to (`demo/posters.mjs`, attached to every release as
  `demo-posters-<version>.zip`) is shot by the rig from that same build, and its `manifest.json`
  carries that same `version`, so the site can refuse a set that is not the demo it deploys. It
  also carries each poster's `focus` rect, measured through `boot.js`'s own
  `__demoBoot.focusRectOf`, so a poster crop and the live frame's ready message are one measure.
- **The sample install is one dataset.** The marketing captures and the web build both seed
  `demo-dataset.ts`; terminal content comes from recordings in `tests/captures/fixtures/demo/`
  made by `scripts/capture-agent-scrollback.js` and sanitized at record time. There is no
  hand-authored terminal content, and the build refuses to seed a session without a recording.
- **What a visitor can start is recorded too.** The transition engine is not in a browser, so a
  drag into an auto-spawn column and a new Command Terminal replay boots the matrix records from
  the dataset (one per task and permission mode, one per project), announced through the same
  pushes main sends. Never fake a spawn with generated bytes or a hand-written transcript.
- **A session's clock is the recording's, and it runs whether or not a terminal is open.** A
  session the board shows as working opens its recording a fixed span before the end and plays
  that span out; when a recording that ran to the agent's own end reaches it, the session flips to
  needs-you, as main's activity engine does when a turn completes. The card, the sidebar count and
  the Monitor therefore change at the moment a window would show the answer land, not when the
  visitor happens to open one. A still frame paints that same opening moment, so a capture and the
  live frame start from the same place.
- **A card's own text is recorded too, and a mock that answers with nothing is not parity.** Card
  Preview defaults to `agent-latest-message`, so a card prints the agent's newest message rather
  than the description. That prose is in the agent's transcript, never in the terminal bytes. Each
  recording carries a `messageTrail`, derived by importing main's own parsers and
  `assistantMessagePreviews`, on the recording's own clock. It is seeded before the renderer
  mounts, and the rest is scheduled from there.
  Unlike the timelines this cannot be recomputed from a recording, so the
  lines are committed and the guard asserts presence. A trail that is legitimately empty (no
  transcript parser for that agent, a transient Command Terminal, a capture whose prose was all
  thinking blocks) is enumerated with its reason rather than left to read as a gap. This is the
  shape to watch for on every new data-backed card surface: the bridge method existing and
  returning nothing passes every structural check while the feature is invisible.
- **What the Monitor shows moving is recorded too.** A card's output peek changes as the agent
  works, so each recording carries the timeline of those changes (`peekTimeline`), derived from
  its own stream by one shared module and sampled to a readable cadence with no random number in
  it, because the built files are content-hashed. A frame showing only the Monitor still fetches
  no recording. `loop=1` restarts a finished session on its own clock and repaints a mounted
  terminal from the opening frame rather than re-feeding its history; it is off by default, and
  a still frame arms no timer at all.
- **A terminal is brought to the recording's grid, or plays frames; it is never left dead or
  finished.** A recording's bytes address rows for their own grid, which no page can promise: the
  board's bottom panel is 15 rows against a session's 37, and a grid moves with the host's frame
  size and the visitor's display scale. Wherever the pane can show the recording's grid at a
  readable size, the seed answers the terminal's resize the way main answers one it refuses, with
  the grid it holds (`SessionResizeResult.held`), and the terminal conforms to it (`useTerminal`'s
  `conformToHeldGrid`: that grid, the font scaled to fit, letterboxed), so the bytes replay
  exactly. Where it cannot (the panel), every recording carries a `frameTimeline` beside its
  stream, PHYSICAL rows with an absolute cursor (`scripts/lib/demo-frame-serializer.js`), and the
  applier fits each row to the grid: cut at the edge, never wrapped; only a horizontal rule
  stretched; gaps never grown. A grid mismatch is also not an ending: main routes a
  geometry-changed session to its parsed frame on the desktop and the agent goes on working, so a
  working session here keeps its clock, its card and its Monitor peeks. Never conflate "cannot
  replay these bytes" with "the agent finished", never answer a grid mismatch with a second
  recording at that grid (the grid is not stable enough to record against), and never hand the
  serialize addon's joined rows to a terminal of another width. A tiled LAYOUT is a surface, not
  a mismatch: the matrix records a session at the tiled width too when the manifest names a
  `tiled` sibling, at the grid `node demo/measure.mjs --geometry` measures for that surface at the
  launch the manifest's `geometry` names, and the seed shows whichever of the two the window's
  width asks for. The sibling is a second run of the prompt, so it supplies the terminal's bytes
  only; the session's clock, trail, diff, and peeks stay the single recording's.
- **The conversation viewer shows a recorded transcript, or the mock's empty answer, never a
  written one.** A session the manifest marks `transcript` carries the agent's own transcript
  beside its recording (`transcripts/<file>`, main's parsers over the history file the agent
  wrote, sanitized whole, committed because the source lives on the recording machine), and the
  seed serves it through `transcripts.get` when a viewer opens. Every other session falls through
  to the mock's empty response, which is what the desktop shows once a history file is gone.
- **The `demo` Playwright tier stays green**, and it runs on the exact bytes a release deploys.

## Enforcement (self-maintaining)

- **Test (mechanical, CI):** `tests/unit/mock-electron-api-parity.test.ts` parses the
  `ElectronAPI` interface with the TypeScript compiler API, evaluates the mock in a `node:vm`
  context, and fails on any declared method the mock does not implement. Runs via
  `npm run test:unit`.
- **Test (mechanical, CI):** `tests/unit/demo-fixtures-sanitized.test.ts` scans every recording
  and the dataset modules for a home directory, a user name, an email address, a temp path, or a
  client name. Runs via `npm run test:unit`.
- **Test (mechanical, CI):** `tests/unit/demo-message-trail-seeded.test.ts` fails when a recording
  carries no `messageTrail` key, when one is empty without a named reason, when a named reason has
  gone stale, when a line sits outside its recording's span, and when the applier or the loader
  stops reading them. It is the answer to the parity test passing on a mock that answers with
  nothing. Runs via `npm run test:unit`.
- **Test (mechanical, CI):** `tests/unit/demo-transcript-seeded.test.ts` fails when the session
  the `conversation` scene opens has no transcript file, when the file is not a whole conversation
  in the parser's shape, when its entries are not the run the card's trail came from (the trail's
  uuids are transcript uuids), when a marked manifest entry has no file or a file no mark, and when
  the build or the seed stops reading them. Runs via `npm run test:unit`.
- **Test (mechanical, CI):** `tests/unit/demo-guest-pages.test.ts` reads every `guest_page`
  `DEMO_PROJECTS` names and fails when the file is missing, references anything off-origin, reads
  `prefers-color-scheme`, or declares an animation or transition. Runs via `npm run test:unit`.
- **Test (mechanical, CI):** `tests/unit/demo-frame-format.test.ts` fails when any recording's
  final frame, open frame, or timeline frame is not physical rows with a cursor suffix, or holds a
  row wider than the recording's columns (the "run the backfill" backstop);
  `tests/unit/demo-frame-serializer.test.ts` round-trips the serializer, including the two
  recordings from task #673, and `tests/unit/demo-frame-fit.test.ts` runs the applier lifted out
  of the GENERATED seed over those recordings at the grids that broke (no spill, no stripe, the
  cursor on its row); `tests/unit/demo-cell-widths.test.ts` pins the applier's width table to
  `wcwidthV11`. Run via `npm run test:unit`.
- **Test (behavior, CI):** `tests/ui/terminal-held-grid-conform.spec.ts` drives the renderer's
  conform against the mock's held answer: a held grid is taken at a smaller font, an accepted probe
  releases it, and a plain refusal conforms nothing.
- **Test (mechanical, CI):** `tests/unit/scene-registry.test.ts` runs over the real `SCENES`
  and fails when a reach tag disagrees with the steps (a `state` scene with steps, a `boot` scene
  with a rig step, a `driver` scene with none), when `alt`, `ready`, or `description` is missing
  or an alt carries a dash or a curly quote (the writing-style scan excludes `tests/`, so this is
  the only check the alts get), when a patched task or session id is not one the sample install
  seeds, when a config key is not an `AppConfig` key (the mock's `Object.assign` accepts any key
  and the renderer never reads it), when the settings scenes stop matching `SETTINGS_TABS` one to
  one or a `setting-row-<id>` marker names a row that is not on that tab, and when `boot.js`'s
  `STATE_KEYS` or `demo/vite.config.mts`'s `scenes.json` fields drift from the type. Runs via
  `npm run test:unit`.
- **Test (behavior, CI):** `tests/demo/static-demo.spec.ts` boots EVERY bootable scene in the
  registry from a static server (the loop iterates `SCENES`, so a new entry is covered with no
  test change, and a stale deep marker for a retired scene fails) and asserts its `ready` element
  visible and, where the scene names a `focus`, that the element exists and covers a real region
  of the frame (not empty, not the whole frame: the Quick Find scenes once named the palette's
  full-frame backdrop, which crops to nothing), that a `driver` scene is refused by name, that `scenes.json` is served, lists exactly
  the registry, and names the frame's version, that the ready message posted to an iframe host
  carries a dialog scene's focus rect (the same rect `__demoBoot.focusRectOf` hands the poster
  rig) and null for a scene without one, the embed and theme
  parameters, the error card for an
  unknown scene, a clean console, zero off-origin requests, that a still frame fetches no
  recording, that the live frame fetches its session's recording, that a live Monitor's output
  peeks change while a still frame's do not, that `loop=1` brings a finished session back and its
  absence leaves it finished, that a terminal on a grid its recording does not fit plays its
  frames and leaves its session working (including the board's bottom panel, where no grid could
  fit), that a held terminal reporting its conformed grid back is read as the conform landing
  rather than a resize, so a session already at its recording's end receives nothing,
  that a board card and a Monitor card draw the agent message trail in place of the
  description and the output peek while a session with no trail still draws its peek, that a
  drag into an
  auto-spawn column and a new Command Terminal each start a session whose bytes arrive through
  the mock's data path, that a still whose terminal is narrower than its recording and not held
  paints its frame cut to the grid rather than raw, that the conversation scene renders the
  recorded transcript from one `transcripts/` fetch and no recording, and that the tiled task
  windows take each session's tiled recording. Runs as the `demo` job in `.github/workflows/ci.yml`
  and again inside `.github/workflows/deploy-demo.yml` before the Pages deploy.
- **Review:** `/code-review` flags a `location` check or a demo flag inside `src/renderer`, and a
  scene entry that carries code instead of data.

## Scope

The web build (`demo/`), the mock bridge, the scene registry and dataset under `tests/captures/`,
and the `demo` tier. The Electron build and the UI test tier are unaffected: the web build is a
separate Vite invocation and never touches `.vite/build/`.
