---
type: Reference
title: Terminal ownership and clipboard
description: "How the bottom panel and task-detail windows share one xterm per session (dialogSessionIds, focused union), the mayTakeArrivalFocus keyboard arbiter, and terminal I/O: bracketed paste, image paste and file drop, copy, OSC 52 clipboard writes, and terminal links (OSC 8, printed URLs and paths, a click for the chosen browser and Ctrl or Cmd click for the other)."
tags: [terminal, ownership, focus, paste, clipboard]
sources:
  - resource: src/renderer/utils/terminal-arrival-focus.ts
  - resource: src/renderer/window-manager/bridge/useWindowSessionClaims.ts
  - resource: src/renderer/utils/panel-sessions.ts
  - resource: src/renderer/utils/focused-sessions.ts
  - resource: src/renderer/utils/terminal-clipboard.ts
  - resource: src/renderer/utils/terminal-link-handler.ts
  - resource: src/renderer/utils/terminal-links/buffer-line-text.ts
  - resource: src/renderer/utils/terminal-links/link-gesture.ts
  - resource: src/renderer/utils/terminal-links/link-path-cache.ts
  - resource: src/renderer/utils/terminal-links/link-providers.ts
  - resource: src/renderer/utils/terminal-links/link-tip.ts
  - resource: src/renderer/utils/link-open.ts
  - resource: src/renderer/utils/terminal-links/link-targets.ts
  - resource: src/renderer/utils/terminal-links/parse-links.ts
  - resource: src/renderer/utils/terminal-links/register-terminal-links.ts
  - resource: src/main/terminal-links/resolve-link-path.ts
  - resource: src/main/terminal-links/link-path-service.ts
  - resource: src/shared/ansi-strip.ts
  - resource: src/shared/hyperlink-env.ts
  - resource: src/shared/terminal-link-limits.ts
  - resource: src/renderer/hooks/useTerminalFileDrop.ts
  - resource: src/main/pty/write-queue.ts
  - resource: src/shared/external-url.ts
    title: TERMINAL_LINK_SCHEMES
---
# Terminal ownership and clipboard

## Terminal Ownership Handoff

- Each PTY session spawns exactly one Claude Code CLI process.
- The bottom panel and the modeless task-detail windows share that process, one xterm per session at a time.
- `dialogSessionIds: string[]` in `SessionStore` lists every session owned by an open task-detail window, in ANY window-manager layer (board, Command Terminal, Agent Monitor). It replaced the scalar `dialogSessionId` once task detail became modeless and windows can stack. It is one array per renderer, so `useWindowSessionClaims` reconciles it across all layers at once.
- When a window claims a session: the panel unmounts that session's xterm instance AND drops its tab, so a detached task leaves no tab that would select an empty pane. The panel keeps every other tab live. `resolveTerminalForceCollapse` (over `derivePanelSessions`) reports which of two reasons holds the panel collapsed. `every-session-detached` applies once no tab is left, and `detail-windows-restoring` applies while a project switch restores its detail windows. Only the first takes the container to zero height (`isEveryPanelSessionDetached`), since the panel has nothing left to render, and closing the window animates it back up. The restoring collapse keeps the 36px strip and snaps rather than animates. A user collapse keeps the 36px strip while any tab is left, since the strip carries the tabs and the expand control. With every session detached there is no tab to carry, so the container is zero height even when the user has collapsed the panel.
- When the window releases it: the tab returns, still selected, and the panel recreates xterm from the PTY scrollback buffer.
- This prevents duplicate xterm instances from sending conflicting resize calls.
- Both surfaces can therefore hold a live terminal at once, so `deriveFocusedSessionIds` focuses the window-owned sessions AND the panel's own session; anything with a mounted xterm must be in that set or the main process suppresses its PTY output.
- **Which of those terminals takes KEYBOARD focus when it arrives is arbitrated, not raced**
  (`src/renderer/utils/terminal-arrival-focus.ts`). The handoff above is exactly what creates the
  race: opening a detail claims its session, so the panel drops that tab and mounts a terminal for a
  DIFFERENT session at the same moment the window mounts its own. Both then fetch scrollback, which
  main delays 150-400ms for the repaint settle, and every arrival path used to end in an
  unconditional `xterm.focus()` - so whichever replay resolved LAST won, and a user who opened a
  task and started typing could have the keystrokes land in whatever agent the panel fell back to.
  `mayTakeArrivalFocus(sessionId, site, terminalElement)` decides from user-intent STATE instead.
  First, a terminal the user cannot see is denied outright (`hidden`): the hook passes its xterm
  element, and `isArrivingTerminalVisible` hit-tests a few points of it against the host pane
  (`data-terminal-host`), so a Delete confirm or the Agent Monitor overlay over the bottom panel
  keeps an arriving panel terminal from taking the keyboard. Then three tiers:
  a claim recorded by a gesture that named a terminal before it existed (a panel tab click, a panel
  expand - the panel is not a window, so neither moves any layer's `focusedWindowId`); else the
  terminal-hosting window holding window-layer focus, resolved by ANCHOR across all three layers
  via `resolveFocusedWindowTerminal` in `dictation-target.ts`; else, when nothing owns the user's
  attention, allow unless focus is in a typing surface. A claim is NOT consumed on grant, because
  one arrival legitimately fires focus more than once (the deferred-init frame, then the mount
  replay); a later window-focus change (the fingerprint) or the TTL is what ends it. Tiers 1 and 2
  DENY a mismatch outright rather than falling through, which is what stops two terminals arriving
  in one frame from both being permitted - including the case where the focused window has not
  spawned a session yet, which still blocks everyone else. Tier 3 has no mismatch to deny, so its
  own guard is a 500ms burst hold (`ARRIVAL_BURST_MS`): several terminals can reach it together on a
  workspace restore that persisted no focused window, and only the first wins. Hosts own the policy
  and pass it to `useTerminal` as an option, so the hook stays
  surface-agnostic. Genuinely user-initiated focus (frame pointer-down, file drop, maximize
  re-homing) is unconditional and marked `// arrival-focus-ok:`. See
  `.claude/rules/terminal-arrival-focus.md`.
- **The arrival is an obligation the replay owes, not a moment it passes through.** A replay arms
  it at START and discharges it via `focusOnArrival`: the two normal completions, plus the three
  that PRE-EMPT one - the stuck-replay watchdog (`SCROLLBACK_WATCHDOG_MS`) and the two IPC
  rejections. The one deliberate exception is a `skipFocus` reload, which does not discharge, since
  letting a reveal or refocus catch-up answer an arrival would move focus on a park/reveal edge
  that is not an arrival at all. Without that, a pre-empted replay took its
  focus decision down with it: the watchdog bumps the replay generation, so the replay's own
  `afterWrite` returns above the frame that asks the arbiter, and it clears the pending flag, which
  lifts the replay veil. The terminal then looks fully arrived and merely unfocusable, while the
  arbiter was in fact never consulted - and nothing asks again, so it stays that way for the life
  of the terminal.
- The converse also holds: anything with NO mounted xterm must be OUT of that set. A collapsed panel renders no `TerminalTab`, so `derivePanelSessionId` returns null for it (`panelShowsTerminal`, threaded from `useTerminalResize`'s `showContent` while the panel is rendered at all; `showContent` alone stays true in Backlog or with the panel hidden in Settings, and the panel's session would then take the first WebGL slot ahead of every visible window). Otherwise main streams bytes nothing can acknowledge, and a chatty agent eventually trips backpressure (`BACKPRESSURE_HIGH_WATER`) and has its PTY paused. Output produced while collapsed accumulates in main's scrollback ring and is replayed when the panel expands and the terminal remounts. A remount is not the only way back: a session that stays MOUNTED and merely leaves the focused union (a detail window a detached monitor owns, a hidden panel, a closed command bar over a transient) is repaired on the focus edge alone, without remounting. See the focus-edge catch-up bullet under [Output streaming](output-streaming.md#focus-catch-up-input-pacing-and-repaint).

## Terminal Paste Strategy

Terminal paste operations use xterm.js's built-in `terminal.paste()` method, which brackets the text (`ESC[200~ ... ESC[201~`) exactly when the foreground app enabled mode 2004 and leaves it plain otherwise. The paste path is unified:

- **Ctrl+V / Cmd+V** - intercepted by a custom key handler, reads clipboard, calls `terminal.paste()`
- **Ctrl+V with a clipboard image** - the image is saved to a temp PNG by the main process (`clipboard:readImage`) and its shell-quoted path goes through the same `terminal.paste()`; what is pasted (the bare path, or the adapter's fallback template) comes from the agent's `PastedImageCapability` (`resolveImagePasteText` in `terminal-clipboard.ts`)
- **File drop** - `useTerminalFileDrop` delivers every dropped path through `useTerminal`'s `paste` handle, one `terminal.paste()` per file so each path is its own packet under bracketed-paste mode; never a raw `sessions.write`. An image in a format the agent cannot attach from a path (`needsImageNormalization`) is first re-encoded as PNG in the renderer (`encodeImageFileAsPng`, Chromium's decoder) and saved by main through `clipboard:saveImage`, and the copy's path is what gets pasted
- **Context menu paste** - follows the same clipboard-read-then-paste path
- **Built-in xterm paste suppressed** - a `paste` event listener on the xterm helper textarea prevents the browser's native paste from double-sending text through xterm's `onData` handler

The bracketing is load-bearing for images: Claude Code scans a paste packet for tokens ending in png/jpg/jpeg/gif/webp and attaches the file as an `[Image #N]` chip in the user turn, so a pasted or dropped image reaches the model with no `Read` tool call. Typed bytes never reach that scan, which is why the image paths do not use a raw write. Main's write queue (`src/main/pty/write-queue.ts`) keeps a packet whole across chunk boundaries, and the PTY buffer manager re-asserts mode 2004 on replay, so a reattached session brackets the next paste correctly.

## Terminal Copy Strategy

Terminal copy operations write to the OS clipboard through the main process
(`clipboard:writeText`), which is focus- and permission-independent.
`navigator.clipboard.writeText()` is deliberately not used: it rejects with `NotAllowedError`
when the document lacks focus, which is exactly the state during a native context-menu click and
when a TUI app emits its copy sequence. The copy paths are:

- **Ctrl+C with a selection / Ctrl+Shift+C** - the custom key handler reads the xterm selection,
  cleans soft-wraps, and writes it via the IPC.
- **Context menu Copy** - the native menu dispatches a `terminal-copy` event; the handler writes
  the selection via the same IPC.
- **OSC 52** - a TUI app (e.g. Claude Code's copy-on-select) copies by emitting
  `ESC]52;c;<base64>BEL`. A write-only OSC 52 handler decodes the payload and writes it via the
  IPC. Read requests (`Pd` is `?`) are ignored so a TUI can never read the user's clipboard back
  out of the terminal.
- **Scrollback replay** - recorded scrollback may contain OSC 52 sequences from an earlier copy;
  the replay path strips them so restoring a session (dialog reopen, resize, respawn) never
  clobbers the user's current clipboard.

### Terminal hyperlinks (OSC 8)

A TUI app can emit `ESC]8;;<url>ESC\` to mark text as a clickable hyperlink. Like OSC 52, these
are agent-controlled bytes with no user intent behind them - anything a session prints, `cat`s, or
echoes can carry one - so activation is gated rather than handed to the OS directly. `useTerminal`
installs a `linkHandler` (`src/renderer/utils/terminal-link-handler.ts`) that opens only on a click
the link gesture accepts (a plain click, or Ctrl click, Cmd on a Mac, where Ctrl+click is a right
click), checks the URL against `TERMINAL_LINK_SCHEMES` (`http:` / `https:` only, no `mailto:`)
from `src/shared/external-url.ts`, and routes an allowed URL to the browser that click names (see
Terminal links below); anything else is dropped with a warning. Supplying this handler also replaces
xterm's built-in fallback, which would otherwise show a native `confirm()` dialog and then open the
URL in a bare, chrome-less `window.open()` window. The handler deliberately leaves
`allowNonHttpProtocols` unset so xterm's own http(s)-only filter stays live as an independent
second check; `tests/unit/terminal-link-handler.test.ts` statically scans `src/renderer` to keep it
that way.

### Terminal links

A terminal has three link sources, in xterm's provider order, and an earlier one wins an overlap:
OSC 8, printed URLs, then printed paths. xterm's Linkifier activates on any click, so each
`activate` checks the modifiers itself. A path shows in its folder on Ctrl or Cmd click (Cmd alone
on a Mac, because Ctrl+click there is a right click and opens the context menu).

**Which browser.** A click on a URL opens the browser the "Click opens links in" setting names
(Settings > Behavior > Links, `linkClickTarget`, the default browser unless changed), and Ctrl click
(Cmd on a Mac) opens the other: the OS default browser through `shell:openExternal`, or the
Kangentic browser beside that terminal. The two clicks are fixed and the setting swaps the browsers,
so there is no hotkey to rebind. The same rule opens a PR pill and a task's artifacts
(`src/renderer/utils/link-open.ts`, `planLinkActions`); `terminal-links/link-targets.ts` reads the
setting at hover and at click and routes the open. The host decides whether a Kangentic browser is
beside the terminal (`useTerminal`'s `linkBrowser` option): a task window offers its pane while the
pane can show, a Command Terminal its slot's pane, and neither does with the project's switch off or
the pane popped out into a window of its own. The bottom panel and the Workflows pane offer none.
With none, both clicks open the default browser. Opening shows the pane the way its Browser pill does and puts a
`browserNavigateRequests` entry in the session store: `BrowserPane` takes it as its first page when
it mounts, or loads it through the webview's own `loadURL` when it already shows one. It is a user's
navigation, so it never goes through main's driver, which would veil the pane as agent-driven
(`agent-driven-focus.md`). An agent driving the pane changes nothing.

**A plain click has three guards**, because a terminal is also where text is selected and where a
TUI reads the mouse (`terminal-links/link-gesture.ts`):

- A press that moves more than `LINK_CLICK_DRAG_THRESHOLD_PX` (4px) is a selection, so it opens
  nothing. The gesture lets go of its claim, and `useTerminal` sends the TUI the press report it
  had held back, so a drag that starts on a link still selects in a mouse-capturing agent.
- A press on a terminal that does not hold the keyboard only brings it forward. It opens nothing,
  so clicking into a terminal never opens a browser by accident.
- A click that does open still drops its press and release reports, so the agent's own link
  handler does not open the link a second time (see below).

A Ctrl or Cmd click has none of the three: it is deliberate, so it opens from any terminal and a
drift of the pointer does not cancel it. Shift and Alt clicks stay xterm's (extend the selection,
force a selection over a TUI's mouse capture) and open nothing. A printed path is unchanged: Ctrl
or Cmd click shows it in its folder and a plain click does nothing.

**The hover tip.** A path shows "Show in folder". A URL shows what each click does, "Open in default
browser" and "Open in Kangentic browser", the plain click first, each with its key chips;
with no Kangentic browser beside the terminal it shows the one row. An OSC 8 link whose cells read
something other than its URL (Claude's status line "canvas" link) adds the URL on a muted line above
the actions, cut with an ellipsis past 480px, with a rule between. `Tooltip` cannot draw it, because it wraps a DOM
element and a link is cells xterm paints, reported through `hover` and `leave` from outside React.
So `terminal-links/link-tip.ts` draws the same tip into the page body with Tooltip's classes,
dwell, placement and one-tip slot, over the cells of the row under the pointer. A repaint over the
link's row makes the Linkifier leave the link and hover it again in the same tick, so a leave closes
the tip only on the next tick, and the same link coming back keeps the tip and its dwell. Without
that, a busy agent restarted the dwell on every frame and the tip never showed. A press, the wheel,
Escape (which it lets through to the agent) or the terminal's disposal closes it at once, and a
press keeps it shut until the pointer leaves the link.

**Why Claude sessions carry `FORCE_HYPERLINK=1`.** Claude Code emits OSC 8 only when it detects a
terminal that supports it. On Windows that means `WT_SESSION`, elsewhere a known `TERM_PROGRAM`, and
Kangentic's terminal has neither. So links appeared in sessions only when Kangentic itself was
started from a Windows Terminal tab, which passed `WT_SESSION` down, and never in a packaged app.
Measured on 2.1.319 under a ConPTY: no OSC 8 without the variable, the same OSC 8 with
`WT_SESSION` or `FORCE_HYPERLINK=1`, and an identical capability log, so it reopens no DECSTBM gate.

It earns its place for what a screen read cannot see: a markdown link whose label differs from its
URL. OSC 8 also carries the whole target on both rows of a wrapped URL. The variable is set for
Claude only (`hyperlinkEnvironment`), because another agent's adapter parses that agent's output and
only Claude was measured.

**Claude does not defer to Kangentic's link handler.** Its docs say it defers in xterm.js terminals,
but it detects those by `TERM_PROGRAM=vscode` or an XTVERSION reply starting `xterm.js`, and
Kangentic sends neither (`pty-spawn.ts`, `xterm-query-replies.md`). So on a click its own
handler would open the link a second time, the double open reported against Windows Terminal.
`terminal-links/link-gesture.ts` prevents it: a capture-phase `mousedown` claims a press that opens
the hovered link (a click or Ctrl or Cmd click on a URL, Ctrl or Cmd on a path), and `useTerminal`'s `onData` drops that click's press and release reports. It
reads the DOM event because the mouse protocol cannot encode Cmd, so on a Mac a TUI would read a
plain click. Text with no link under it is not claimed, so Claude still handles what Kangentic does
not link.

**OSC 8 does not survive a replay.** `@xterm/addon-serialize` writes no `urlId` (xterm.js#4531, open,
and the newest beta on 2026-11-07 still drops them), so a mount replay of
an alt-screen frame has lost its links until the agent repaints those cells. An idle session sends
no frames, so a reopened window can show them as plain text for as long as it stays idle. The URL
provider then links what is printed.

**Links work without an agent's cooperation.** Every agent gets the plain URL and path providers and
the same Ctrl or Cmd click. Most agents draw their own screen, and four of the eight probed at boot
capture the mouse too (Codex, Copilot, OpenCode, Grok, with Antigravity on the alternate screen
without it). Those TUIs wrap a long link themselves, indenting the next row, so xterm sees separate
lines. `continuesOnNextRow` (`buffer-line-text.ts`) reads that shape off the screen: the row's text
runs close to its edge, its last word holds a path separator, and the next row opens at a small
indent with a word too long to have fit in the gap. A TUI's border is not text, so the gap is
measured to it: Copilot's prompt echo wraps seven cells short of its panel border, and Claude's one
cell short of the grid. The separator keeps two wrapped words of prose from joining, and the gap
test tells a break inside a long word from a line that ends in a URL. A guess can still be wrong: a
URL near the edge above a long unrelated word joins it, and that click opens a wrong address on the
same site. The two rows of a very short tail in a narrow text column can also read as separate, and
then the URL opens cut short. That is the cost of not asking the agent, and an agent's own OSC 8 link
wins any overlap.

**Printed paths resolve in main, by session id** (`src/main/terminal-links/`). The renderer sends
text and never a path to act on, and main resolves it again at the click. A click reveals the file
in the file manager through `shell.showItemInFolder`, which cannot run anything: `shell.openPath`
would run a printed `.exe`. `:line` is parsed so the path resolves, and is otherwise unused.

- A hover is one batched `session:resolveLinkPaths` per row at most. `xterm` asks when the pointer
  enters a row, never from the render path, and a per-terminal cache answers repeats (3 s for a
  missing path, so a file an agent just wrote links soon, and 60 s for one that exists).
- `linkPlaceOfSession` fails closed. A session on a remote `executionTarget`, or with a CLI target
  it does not classify, links nothing. Its switch over `StoredCliTarget['kind']` fails typecheck when
  an SSH target is added, and must classify it as null, since that host's paths are not on this
  computer. A project's own remote flag must route there too.
- **A UNC path never reaches a stat.** Reading `\\host\share\x` from agent text would send this
  user's Windows credentials to that host on a mouse-over. `\\?\` and `\\.\` are refused with it. The
  one UNC root allowed is the session's own distro share, and only while `isWslDistroRunning`, since
  a read would start a stopped distro.
- A WSL session maps `/mnt/c/...` to the drive and other Linux paths through
  `\\wsl.localhost\<distro>`. A bare `wsl` shell asks `wsl.exe -l -v` for the default distro.

**What OSC 8 costs a reader of the stream.** A link's URL sits in the raw bytes, and every full
repaint sends it again, so a read of those bytes has to treat it as a sequence.

- The pty host's headless parser drops OSC 8 with a no-op handler. xterm keeps a marker per row a link
  is drawn on, and the alternate screen releases none until it exits. A replay of 6,000 scrolling
  frames reached 72,000 markers and 125 MB, in a parser every session runs. Its serialize output is
  unchanged, since the addon writes no link.
- A renderer terminal needs its links and has no public way to release a marker, so it keeps them
  (about 1.7 KB each, at most one per link per row) until the terminal unmounts. A reopened window
  starts from a replay with none. Reported as xterm.js#6303.
- A slice of the stream can start inside a sequence. `findSafeStartIndex` and the replay and phone
  barriers skip the rest of a cut payload with `skipTruncatedStringSequence`, and `TranscriptWriter`
  holds a sequence cut at a chunk's end for the next chunk. A parser state read would be exact, and
  xterm.js#6234 asks for one.
- The phone's live feed drops OSC 8 and keeps the labels (`createHyperlinkStripper`). The mobile
  terminal sets no `linkHandler`, so a tap would reach xterm's `confirm()` and `window.open()` fallback
  in a WebView with no second window, and its seed frame has no links anyway.
- `pr-linking.ts` calls `exposeHyperlinkTargets` before its fallback scrape, since a stripper takes
  the only copy of a URL behind a short label.

Two limits are accepted. `ssh` typed by hand in a local shell cannot be detected, so a remote path
that also exists locally links to the local file. There is no OSC 7 tracking, so a relative path
printed after a `cd` resolves against the session's starting folder, and usually does not link.
