---
paths:
  - "src/renderer/**"
---
# Rule: every tooltip is the `Tooltip` component

Hover text in the renderer used to be a native `title` almost everywhere. A native tip is slow and
unstyled, a keyboard user never sees it, it cannot draw a shortcut's key chips, and a test can read
it only as an attribute. `Tooltip` (`components/Tooltip.tsx`) replaces it: a body-portal tip that
opens on hover and when Tab moves focus to its trigger, draws live key chips, and gives its text to
the trigger as an `aria-description`.

## The rule

- **Explanatory hover text is a Tooltip.** Wrap the ONE element it explains:
  `<Tooltip label="..."><button ... /></Tooltip>`. Tooltip adds no element around it. The child
  must pass pointer, focus and click handlers and `aria-description` through to a DOM node. A plain
  element does; a component must forward them.
- **There is no native `title` anywhere in the renderer.** That includes the full value of text the
  layout cuts short (a truncated path, branch name or model id): it is a Tooltip with the whole
  value, so every tooltip in the app has one look. A native tip is square and OS-styled beside the
  rounded Tooltip, and a user sees the two side by side. There is no opt-out marker.
- **A tip never names its trigger.** An icon-only control carries its own `aria-label`, and the tip
  only describes it. A label that repeats the name is not read twice. The exception is a
  `SegmentedControl` option's `tip`, which names the option on purpose. Once a collapse step leaves
  the option an icon, as the board toolbar's view switcher does, the tip is the only visible label
  it has.
- **A control that shows its label carries no tip that repeats it.** No static tip restates the
  label or the section header above it (the Settings sidebar's "Applies to all projects" under
  SYSTEM), and no tip is a generic "Click to..." instruction. A tip says what the control does not
  already show: the full value of cut-short text, a disabled reason, a shortcut, live state. A
  label that a JS collapse step hides gets its tip only while hidden, the way `Tabs` gates on
  `iconAlone` and the board toolbar gates on `filtersCollapsed` / `switcherCollapsed` /
  `primaryCollapsed` (`board/toolbar-collapse.ts`). A tip that reports live state (the
  Workflows option's "2 running") shows at every step. A label that a container query hides keeps its tip at every
  width, because a tip cannot follow a container query (`WorkflowHeader`,
  `CompletedHeaderStrip`).
- **An optional tip passes straight through.** An empty label holds the tip shut, so
  `label={tip ?? ''}` needs no `enabled`. `enabled={false}` is for a tip with text that must stay
  shut, such as a trigger whose menu is open. A disabled control shows why with `tipLabel`
  (`utils/tooltip.ts`), which every `disabledReason` prop uses.
- **A shortcut is `keys="<KEYBINDINGS id>"`, never a combo typed into the label.** The chips follow
  the user's rebind.
- **Tests never select by `title`.** Use role and name, `aria-label`, or a `data-testid`, and assert
  hover text with `toHaveAccessibleDescription`.

## Enforcement (self-maintaining)

- **Test:** `tests/unit/native-title.test.ts` parses every renderer `.tsx` and fails on any native
  `title` attribute, SVG `<title>`, or object spread carrying `title`, naming each site.
  `src/renderer/components/debug/` (dev-only, built out of production) is the one exemption. Runs
  in CI via `npm run test:unit`.
- **Test:** `tests/ui/controls-have-names.spec.ts` strips every `title` before React renders and
  fails on a control with no accessible name, which is what a migrated control that leaned on its
  title becomes. `tests/ui/tooltip.spec.ts` pins the timing, placement, Escape and description.
- **Test:** `tests/unit/tooltip-copy.test.ts` parses every renderer `.ts` and `.tsx` and fails on
  any string literal, template (so `t` and `msg`) or JSX text (so `<Trans>`) that opens with
  "Click to". It reads strings rather than Tooltip props, so a tip built in a local or a helper is
  caught too. It drives its detector over known-bad source. Runs in CI via `npm run test:unit`.
- **Review:** a tip that restates its control's label or section header needs to know what the
  control shows, so `/code-review` is its only guard. The criterion is the `one-tooltip.md` line in
  that skill's Project Conventions list (`.claude/skills/code-review/SKILL.md`), which the
  always-on conventions finder checks on every review.
- **Gap:** a component that spreads `...rest` passes a `title` it was given straight past the scan.
  Pill, IsolatedBadge and Select omit `title` from the attributes they accept; any other forwarding
  wrapper is review-only.

## Scope

Hover text under `src/renderer/`. Does not govern the dev-only overlays under `components/debug/`,
or a component prop named `title` that is a heading (ConfirmDialog, BaseDialog).
