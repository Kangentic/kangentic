---
paths:
  - "src/renderer/hooks/useTerminal.ts"
  - "src/renderer/utils/terminal-dispose.ts"
---
# Rule: an opened xterm releases mouse tracking before it is disposed

With mouse reporting on, which is every Claude Code terminal (its fullscreen TUI sends `?1000h
?1002h ?1003h ?1006h`), a mousedown on an xterm 6 terminal parks a `mouseup` listener on
`document`, plus a drag `mousemove` listener under `?1002h` / `?1003h`. xterm registers neither as
a disposable. Only the mouseup handler itself, after it reports the event, or a mouse protocol
change removes them. Dispose the terminal while one is pending and the next mouseup anywhere in the
window throws `Cannot read properties of undefined (reading 'dimensions')` before the removal runs.
The listener then throws on every later click for the life of the page and keeps the dead terminal
reachable. That was Sentry DESKTOP-1G: 709 events from 5 installs, 659 of them one install in one
day. The pending listener does not need a held button: most field bursts started on the first
click after the window regained focus, so the listener was armed long before and the terminal was
disposed while the user was away.

## The rule

- **Call `releaseMouseTracking(terminal)` (`src/renderer/utils/terminal-dispose.ts`) on every
  opened `@xterm/xterm` Terminal before `dispose()`.** It sets the private
  `_core.coreMouseService.activeProtocol` to `NONE`, which fires `onProtocolChange` synchronously
  and removes both document listeners whenever they were added. It falls back to the public
  `reset()` if a future xterm renames the service, and it never throws.
- **Call it first in the teardown,** ahead of every other step, so a step that throws cannot skip
  it. `useTerminal`'s unmount cleanup is the one live dispose of a mounted terminal and opens with
  it.
- **Do not replace it with `write('\x1b[?1000l')`.** `write()` parses on a later task, after
  `dispose()` has already torn down the `onProtocolChange` subscription.
- A terminal that is never `open()`ed binds no DOM listeners and is exempt
  (`demo/replay-emulator.ts`). `@xterm/headless` has no DOM and is out of scope.

## Enforcement (self-maintaining)

- **Test (sites):** `tests/unit/terminal-dispose.test.ts` scans `src/**` and `demo/**` and fails
  any file that constructs and opens an `@xterm/xterm` Terminal without calling
  `releaseMouseTracking(`. It pins that the scan still finds `useTerminal.ts`, so it cannot pass
  vacuously, and that `useTerminal`'s cleanup calls it as its first statement.
  The same file drives the helper against a real `@xterm/headless` terminal. Runs in CI via
  `npm run test:unit`. The scan matches a named `import { Terminal } from '@xterm/xterm'`, so an
  aliased (`Terminal as XTerm`) or namespace import escapes it. Review covers that gap.
- **Test (behavior):** `tests/ui/terminal-dispose-mouse-tracking.spec.ts` arms the listeners with a
  real press under Claude Code's four mouse modes, unmounts the terminal with the button held, then
  moves, releases and clicks elsewhere. It asserts no page error, and counts `document`'s
  `mouseup`/`mousemove` listeners over CDP, both to prove the press armed them and to prove none
  outlived the terminal. It is red without the release. It guards the behavior, not the private
  path: after a rename of `coreMouseService` the `reset()` fallback removes the listeners too, so
  it stays green. The rename tripwire is the headless unit case, which asserts the private path
  ran without the fallback; it sees `@xterm/headless` 6.0.0 only, not the browser bundle.

## Scope

Every `@xterm/xterm` Terminal that is `open()`ed in the renderer, including dead or debug code.
Does not govern `@xterm/headless` terminals in main or devtools.
