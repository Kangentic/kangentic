---
paths:
  - "src/main/config/**"
  - "src/main/boards/**"
  - "src/main/browser/**"
  - "src/main/mobile-bridge/**"
  - "src/main/db/repositories/**"
  - "src/main/agent/adapters/**"
  - "src/main/transition-engine/**"
  - "src/main/ipc/handlers/**"
  - "src/main/transcription/**"
---
# Rule: a synchronous main-process write either degrades or has a reason to throw

`ConfigManager.save()` ended in a bare `fs.writeFileSync` with no try/catch. On an install whose
userData sat on a removable volume, that write threw `EBADF` from two call sites with no caller
able to recover: a `setTimeout` debounce (no caller at all, so an uncaught exception) and the
`config:set` IPC handler (never caught by the renderer, so an unhandled rejection the user never
saw). Sentry DESKTOP-14/DESKTOP-13. The same shape - a small per-machine or per-project state
file written synchronously from a timer, an IPC handler, or an event callback - repeats across
main: import sources, the Browser pane's URL overrides, the mobile-bridge roster and identity,
the Asana token, the settings/hooks/trust files each agent adapter writes before spawn, the
per-session `.kangentic/sessions/<id>` directory two more pre-spawn chokepoints create, and the
dictation model download's target directory.

## The rule

Every `fs.writeFileSync` / `fs.mkdirSync` / `fs.renameSync` call in the scoped trees below is one
of three things, and a new one must pick which before it ships:

1. **Guarded.** User state where losing the write degrades the session rather than breaking it -
   settings, an import source, a URL override, a paired device, a saved credential. Write it
   through `safeWriteJson` (`src/main/safe-write.ts`): mkdir + write-to-temp + rename, all inside
   one try, reporting through the source-keyed latch in
   `src/main/config/write-failure-notice.ts` on failure instead of throwing. Pick a `source` tag
   for the write's PURPOSE (`'config'`, `'mobile_bridge_roster'`, ...), not its literal file path -
   the tag is what the failure latch is keyed by, and by-purpose keeping means a healthy source's
   next successful write cannot silently clear an unhealthy DIFFERENT source's latch. A caller
   holding an in-memory copy of what it meant to persist (`ConfigManager`) keeps serving it
   regardless of the write's outcome; a caller with no cache (`ImportSourceStore`) simply has
   nothing new to read back until a later write to the same path succeeds.
2. **A deliberate throw.** Earned by a write something downstream cannot sanely proceed without -
   a write that PRECEDES a DB `INSERT` referencing its path (`attachment-repository.ts` - a
   swallowed failure would leave a row pointing at a file that does not exist), a write an agent
   adapter makes before spawn that the CLI cannot run without (hooks, MCP config, or a
   trust/folder-trust entry the CLI would otherwise show as a blocking interactive prompt no
   automated session can answer), or a pre-spawn session directory / model-download target a
   later step in the SAME call unconditionally writes into. Every one of these already has a
   caller that turns the throw into something the user sees or a recovery loop that logs and
   moves on to the next item rather than aborting: an IPC handler rejects and the renderer toasts
   it, `spawnAgent`'s catch calls `reportHandledError` + `notifySpawnBlocked`, or a per-record
   try/catch in a startup recovery loop (`resume-suspended.ts`, `auto-spawn.ts`) marks just that
   one record failed and continues the batch. Mark the call `// sync-write-ok: <reason>` (the
   reason names what depends on this write and where the throw is caught) so the scan below can
   tell a deliberate throw from an overlooked one.
3. **Already inside a `try`.** Several sites already wrap their own write in a local try/catch
   (a hand-rolled tmp+rename, a rethrow with clearer text). That already satisfies this rule; no
   marker needed.

`safeWriteJson`'s own three fs calls are exempt by construction - they are what the guard IS, not
a site the guard governs.

## Enforcement (self-maintaining)

- **Test (mechanical, CI):** `tests/unit/guarded-sync-writes.test.ts` is an AST scan (parses with
  the TypeScript compiler API, not a line-regex) over the nine trees above for
  `fs.writeFileSync` / `fs.mkdirSync` / `fs.renameSync`. A `safeWriteJson(` call is a different
  function and never enters the candidate set at all, so routing a write through the guard takes
  it out of the scan rather than passing it. A candidate passes if it sits lexically inside a
  `TryStatement`'s block, or the source line immediately above (or a trailing comment on the same
  line) reads `// sync-write-ok: <reason>`. The reason must be non-empty: a bare
  `// sync-write-ok:` fails the scan, so the escape hatch cannot wave a write through without
  saying what depends on it. Everything else is an offender, reported with its `file:line`. Runs
  in CI via `npm run test:unit`.
- **Review:** `/code-review` flags a new unguarded write in the scoped trees with neither a
  `safeWriteJson` call nor a marker naming which of the two throw shapes applies.

## Scope

The nine trees in the frontmatter. Two adjacent things are deliberately NOT covered, both by
reasoned exception rather than oversight:

- `src/main/config/board-config/atomic-write.ts`'s `atomicWriteJson` - its docblock already says
  "throws on I/O errors, callers decide"; it is the shared primitive `safeWriteJson` itself
  mirrors, not a site this rule governs.
- `src/main/announcements-archive.ts` - already guarded with its own try/catch, and deliberately
  reports nothing (`docs/configuration.md`: announcements "never emit error telemetry"; losing the
  local archive costs a badge count, never a user action). Routing it through `safeWriteJson`
  would wire a badge count into the same Sentry report and user-facing toast this rule exists to
  add for state that actually matters - do not "fix" it into scope.

Async writes (`fsPromises.writeFile`, the embed-worker's `snapshot-writer.ts`) are a different
failure shape (a rejected promise has a natural catcher) and are out of scope.
