---
paths:
  - "src/shared/xterm-unicode11.ts"
  - "src/renderer/hooks/useTerminal.ts"
  - "src/renderer/utils/ansi-filter.ts"
  - "src/main/pty/buffer/headless-frame.ts"
  - "src/main/pty/virtual-screen.ts"
  - "src/devtools/main/inspection-server.ts"
---
# Rule: every terminal parser runs the Unicode 11 width table, in lockstep

xterm's built-in width table is Unicode V6, which scores modern emoji (U+2705, U+274C, ...)
as single width. Agent TUIs (Claude Code) pad each row with spaces to the FULL terminal width
counting those glyphs as double, and reach the next row by autowrap rather than CR/LF - so
under V6 every emoji left a row one column short, the wrap fired one character late, and each
following row of the frame drifted one column further left, with the fallen-off characters
stacked down the right edge of the row above (task #557). The Command Terminal made it
permanent: `getScrollback` serves a re-serialization of the already-drifted parsed grid, so
every reopen replayed identical corruption. A refit or resize does NOT fix this - a SIGWINCH
repaint only clears the accumulated drift for one frame.

Lockstep matters more than the table itself. Main's headless parser serializes frames that
renderer terminals (and the phone's) replay with relative cursor moves, so two parsers
disagreeing on a width diverge worse than both being wrong together.

## The rule

- **Every `new Terminal(`** (from `@xterm/xterm` or `@xterm/headless`) calls
  `activateUnicode11(terminal)` from `src/shared/xterm-unicode11.ts` immediately after
  construction, before any `write()` or `open()`. Both of the helper's lines are required:
  `loadAddon` alone only registers the provider (the terminal stays on V6), and the
  `unicode.activeVersion = '11'` switch requires `allowProposedApi: true` in the constructor
  options. Never load the addon in a later effect - bytes already parsed under V6 keep their
  V6 layout.
- **Hand-rolled grid parsers take widths from `wcwidthV11`** (same module), which captures the
  addon's own provider - the exact table the xterm instances run. Never introduce a private
  width table or per-code-unit column advance (`src/main/pty/virtual-screen.ts` is the
  precedent consumer).
- The helper's structural `Unicode11HostTerminal` parameter bridges both packages' nominally
  distinct `Terminal` types; no per-site cast is needed or wanted.
- The phone's replaying xterm (the `Kangentic/mobile` repo) must activate unicode11 the same
  way; that repo is out of mechanical reach here, so `docs/mobile-bridge.md` carries the
  contract note.

## Enforcement (self-maintaining)

- **Test:** `tests/unit/xterm-unicode11-activation.test.ts` scans `src/**` (including
  `src/devtools/`) and fails any file whose `new Terminal(` count exceeds its
  `activateUnicode11(` count, verifies the helper switches a real terminal to `'11'`, and
  pins `virtual-screen.ts`'s import of `wcwidthV11`. Runs in CI via `npm run test:unit`.
- **Test (behavior):** the `Unicode 11 width parity` block in
  `tests/unit/headless-frame.test.ts` replays the drift repro (emoji row padded to full
  width, autowrap layout) through the parse and the serialize -> replay round trip; the
  VirtualScreen wide-char cases live in `tests/unit/claude-model-picker-probe.test.ts`.

## Scope

Every xterm `Terminal` construction and every hand-rolled screen-grid parser in the repo,
dev tooling included (the forensics re-parse diagnoses the other parsers and must not lie).
The mobile app's terminal is governed by the doc note, not by this repo's tests.
