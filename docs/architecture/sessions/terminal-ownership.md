---
type: Reference
title: Terminal ownership and clipboard
description: "How the bottom panel and task-detail windows share one xterm per session (dialogSessionIds, focused union), the mayTakeArrivalFocus keyboard arbiter, and terminal I/O: bracketed paste, image paste and file drop, copy, OSC 52 clipboard writes, OSC 8 links."
tags: [terminal, ownership, focus, paste, clipboard]
sources:
  - resource: src/renderer/utils/terminal-arrival-focus.ts
  - resource: src/renderer/window-manager/bridge/useWindowSessionClaims.ts
  - resource: src/renderer/utils/panel-sessions.ts
  - resource: src/renderer/utils/focused-sessions.ts
  - resource: src/renderer/utils/terminal-clipboard.ts
  - resource: src/renderer/utils/terminal-link-handler.ts
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
  keeps an arriving panel terminal from taking the keyboard. Then four tiers:
  a claim recorded by a gesture that named a terminal before it existed (a panel tab click, a panel
  expand - the panel is not a window, so neither moves any layer's `focusedWindowId`); else a
  window an AGENT opened or raised, which denies EVERYONE including its own terminal while it
  holds focus (`openedByAgent`, see `.claude/rules/agent-driven-focus.md`); else the
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
- The converse also holds: anything with NO mounted xterm must be OUT of that set. A collapsed panel renders no `TerminalTab`, so `derivePanelSessionId` returns null for it (`panelShowsTerminal`, threaded from `useTerminalResize`'s `showContent` while the panel is rendered at all; `showContent` alone stays true in Backlog or with the panel hidden in Settings, and the panel's session would then take the first WebGL slot ahead of every visible window). Otherwise main streams bytes nothing can acknowledge, and a chatty agent eventually trips backpressure (`BACKPRESSURE_HIGH_WATER`) and has its PTY paused. Output produced while collapsed accumulates in main's scrollback ring and is replayed when the panel expands and the terminal remounts. A remount is not the only way back: a session that stays MOUNTED and merely leaves the focused union (a detail window a detached monitor owns, a hidden panel, a closed command bar over a transient) is repaired on the focus edge alone, without remounting. See the focus-edge catch-up bullet under Output Streaming.

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
installs a `linkHandler` (`src/renderer/utils/terminal-link-handler.ts`) that checks the URL
against `TERMINAL_LINK_SCHEMES` (`http:` / `https:` only, no `mailto:`) from
`src/shared/external-url.ts` and routes an allowed URL to the OS default browser via
`shell:openExternal`; anything else is dropped with a warning. Supplying this handler also replaces
xterm's built-in fallback, which would otherwise show a native `confirm()` dialog and then open the
URL in a bare, chrome-less `window.open()` window. The handler deliberately leaves
`allowNonHttpProtocols` unset so xterm's own http(s)-only filter stays live as an independent
second check; `tests/unit/terminal-link-handler.test.ts` statically scans `src/renderer` to keep it
that way.
