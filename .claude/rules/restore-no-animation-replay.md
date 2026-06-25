---
paths:
  - "src/renderer/**"
---
# Rule: a programmatic restore must not replay entrance or change animations

Kangentic re-mounts and re-populates UI on a project switch (and on workspace restore, session
re-bind, and a hard reload): the destination project's task-detail windows are rebuilt, the
bottom panel rebinds, and every per-session / per-project metric flips to the new context's
numbers. None of that is a user-initiated *action* or a *live* change. It is a context reset, and
it should present a flat, calm canvas. When restore code reuses the same mount path as a fresh
user open, two distraction classes leak in: entrance animations replay on the restored windows
(fade + scale + slide), and value-change pulses fire across the status/context bars as their
numbers jump from project A's session to project B's. The user experiences a flurry of motion on
what should feel like simply arriving. This rule keeps restore quiet while leaving genuine user
opens and live ticks fully animated.

## The rule

A programmatic context restore (project switch, workspace restore, session re-bind, hard reload)
must paint flat. The motion that fires on a real user action or a real live update must NOT fire
when the same UI is reconstructed or re-pointed by a restore.

- **Restored windows start visible, not entering.** A window rebuilt by `deserializeWorkspace`
  carries the transient `skipEnterAnimation: true` flag (never persisted); `WindowFrame` forwards
  it to `useOverlayPhase` as `skipEnter`, which seeds the phase to `'visible'` so the entrance
  keyframes never run. A fresh `openWindow` leaves the flag unset, so a user-opened window keeps
  its entrance. Do not remove the flag plumbing, and do not start a restored overlay in
  `'entering'`.
- **Value pulses rebaseline on context identity.** Every `useValuePulse(value, ...)` call MUST
  pass a `resetKey` identifying the context the value belongs to (the project id for a
  project-scoped aggregate, the session id for a per-session metric). When the `resetKey` changes,
  the hook rebaselines silently instead of pulsing, so a context switch does not animate; a live
  in-place change with a stable `resetKey` still pulses. A call that genuinely never re-points
  across a context boundary may opt out with a `// value-pulse-ok: <reason>` marker on the call
  line or the line above.
- **New animated surfaces follow suit.** Any new entrance keyframe, transition, or change-pulse
  on a surface that can re-mount or re-populate during a project switch / restore must suppress
  itself on the restore path the same way (a per-instance "restored" flag, or a `resetKey`-style
  identity gate). Do not add motion that replays on arrival.

## Enforcement (self-maintaining)

- **Test (value pulses):** `tests/unit/restore-no-animation-replay.test.ts` scans `src/renderer/**`
  and fails if any `useValuePulse(` call site omits `resetKey` and lacks a `// value-pulse-ok:`
  marker. Runs in CI via `npm run test:unit`.
- **Test (window restore):** `tests/unit/window-workspace.test.ts` locks that `deserializeWorkspace`
  stamps `skipEnterAnimation: true` on every rebuilt window and that `serializeWorkspace` never
  persists it. Runs in CI via `npm run test:unit`. UI-tier coverage of the end-to-end restore
  (flat paint) lives in `tests/ui/window-no-entrance-animation-on-restore.spec.ts`.
- **Review (new surfaces):** `/code-review` flags a newly added entrance/transition/pulse that
  would replay on a project switch or restore. A brand-new keyframe on a brand-new surface is not
  mechanically detectable (the scans cover only the two known mechanisms above), so this is the
  judgment backstop and is called out deliberately.

## Scope

Renderer UI under `src/renderer/`. Governs motion that fires on mount or on a value change for
surfaces reconstructed/re-pointed by a restore. Does not govern ongoing ambient motion
(`animate-spin`, `animate-pulse-subtle`, the activity `march-border`) or genuinely user-initiated
open/close animations, which are intentional and stay.
