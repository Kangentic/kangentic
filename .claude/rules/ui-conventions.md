---
paths:
  - "src/renderer/**"
---
# Rule: renderer UI conventions

The renderer has shared primitives, selectors, and styling floors that keep the UI consistent,
readable, and testable. New UI code reintroduces raw elements, tiny fonts, and inconsistent
chrome unless these are stated.

## The rule

- **Icons:** use Lucide React icons. No inline SVGs. Exactly three files are exempt, each
  consuming a shipped `@kangentic/branding` asset that cannot be a lucide glyph:
  `components/BrandMark.tsx` (the brandmark lockup), `components/ActivityMark.tsx` (the nine
  activity marks, shared with the website and mobile app), and
  `components/command-bar/CommandTerminalIcon.tsx` (a wrapper over `ActivityMark`). Each carries
  a comment naming this rule. Adding a fourth needs the same justification, not a silent inline
  `<svg>`.
- **Dropdowns:** use the shared `Select` component from
  `src/renderer/components/settings/shared.tsx`, never a raw `<select>` with inline classes.
  The shared component renders `appearance-none` with a custom ChevronDown for correct spacing.
- **Setting label + description:** use the shared `SettingText`
  (`src/renderer/components/SettingText.tsx`), or its `SETTING_LABEL_CLASS` /
  `SETTING_DESCRIPTION_CLASS` when a surface needs the two parts separately. Never re-type the
  label/description class pair inline.
- **Control fill:** every input-like control draws one fill, border, and value colour, off the
  `surface-control` / `edge-input` tokens. Use `FIELD_CONTROL_CLASS` / `FIELD_SELECT_CLASS`
  (`src/renderer/components/Field.tsx`) in dialogs and `INPUT_CLASS`
  (`settings/shared.tsx`) in the settings panel. `Combobox`, `ToggleCard`, and
  `SegmentedControl` each match that fill deliberately and say so in a comment, so a one-off
  `bg-*` on a new control breaks a family that is being held together by hand.
- **Numeric counts:** use the shared `CountBadge` (`src/renderer/components/CountBadge.tsx`)
  with its `muted` / `accent` / `solid` variants. Do not inline badge styles.
- **Confirmations:** use `ConfirmDialog` for all yes/no prompts; set `showDontAskAgain` when the
  confirmation should be suppressible. Never build a one-off modal for a simple confirmation.
- **Dialog dismissal:** all dialogs use a global `useEffect` Escape key listener.
- **Test selectors:** add `data-testid` and `data-swimlane-name` attributes for test selectors.
- **Clickable controls ignore text selection.** A hand-rolled clickable control (a non-`button`
  element with an `onClick` and an action cursor: `cursor-pointer`, `cursor-grab`, `cursor-move`,
  `cursor-col-resize`, `cursor-row-resize`) carries `select-none`, so a press that drifts a few
  pixels runs the gesture instead of selecting the label. The cursor set is the one
  `light-dismiss-denylist.md` already enumerates. A drag source counts: the board's `TaskCard` is
  `cursor-grab`, and a stray selection breaks a drag at least as badly as it breaks a click.
  Native `<button>` gets this from
  the `@layer base` rule in `index.css`, which stays scoped to native buttons because `role="button"`
  is spread onto dnd-kit wrapper divs. `user-select` is inherited, so a container's `select-none`
  reaches every descendant: where a control holds text a user copies (a live output line, a ticket
  id), put `select-text` on that child rather than dropping the container's `select-none`. A control
  that should not carry it (a bare checkbox wrapper, an empty spacer, or a row that scopes
  `select-none` to its text-bearing child instead) opts out with `// select-none-ok: <reason>`.
- **Minimum font size:** default small text is `text-xs` (12px). The minimum is `text-[11px]`,
  reserved for very tight spaces (badges, column headers). Never `text-[10px]` or smaller
  without explicit approval. Empty states, descriptions, and hints use `text-sm` (14px) or larger.
- **Avoid hover-only controls for important actions.** Hover-revealed buttons
  (`opacity-0 group-hover:opacity-100`) get overlooked and exclude keyboard / touch users.
  Prefer a right-click context menu or an always-visible control; reserve inline visible buttons
  for the single most-used primary action. Default to visual subtraction over addition.
- **A persistent chrome row stays usable at the 900x600 floor.** The title bar, the board and
  backlog toolbar, and the status bar are always on screen, so every one of them has to hold at
  `minWidth: 900` / `minHeight: 600` (`src/main/index.ts`) with the sidebar at BOTH extremes: its
  36px collapsed strip and its 400px maximum, which nothing clamps to the window. A 400px sidebar
  at a 900px window leaves the toolbar 495px, so that is the number to design against, not the
  window width.
  - **Give the row a shrink strategy, never a single victim.** A row of content-sized children
    with one flexible child makes that child pay for everything: the board toolbar's fixed 21rem
    search meant the "Add column" label wrapped and then clipped off the right edge, with
    `body`'s `overflow-hidden` and no scrollbar to recover it. Decide the order controls give
    ground in, and write it down.
  - **Collapse by container query, not by viewport breakpoint.** `@container` on the row plus
    `@[NNNpx]:` variants reads the space the row actually has, with the sidebar already
    subtracted, so one set of thresholds covers every sidebar width and the row responds to a
    sidebar drag as well as a window resize. `src/renderer/components/board/toolbar-collapse.ts`
    is the worked example, with `BoardManagerDialog`, `MonitorBody` and `form-layout.tsx` as
    the other adopters. Every class must be a complete literal, since Tailwind scans source text.
  - **An icon-only control keeps its name.** `hidden` on a label removes it from the
    accessibility tree, so a control that sheds its text carries `aria-label` and `title`.
  - **Watch the flexible child, not just the clipping.** A search field with a max and no min
    absorbs the whole shortfall silently: the row fits perfectly while the field shrinks to
    92px. "Nothing clipped" is not the same as "still usable", and only the first is visible in
    a layout check.
- **Copy for labels and descriptions.** House writing style is the always-on
  [[writing-style]]; this bullet adds only what is specific to a settings row.
  - **One sentence, about 110 characters.** That is what fits the row's `text-xs` column without
    wrapping past two lines. "Two sentences" is not a budget; it wrapped to four lines in practice.
    State the effect and, if it is genuinely needed, one distinguishing clause. Drop flag names,
    issue numbers, and "applies only to X sessions" caveats. Model: existing registry entries like
    "Fold away large unchanged spans so a big file shows only the changed hunks with a little
    context."
  - **Never open with a rhetorical or leading question** ("No app yet?", "Need help?"). A question
    presumes a state the reader may not be in, and the section is not conditioned on the answer.
    Write the noun phrase for what is behind the control, and keep sibling labels parallel ("How
    the relay works" / "How to install and pair").
  - **Essential AND non-obvious.** On a panel a user opens constantly (New Task, task detail,
    settings), that is the bar for any standing text. A label that teaches a feature is paid on
    every open and learned once. When asked to cut text load, give a verdict per string (essential?
    non-obvious? keep or cut), not layout variants that relocate the same sentences. A hint that
    compensates for an unclear control means the control needs fixing, not the hint.
  - No raw hex, byte codes, control-code literals, or escape sequences in a label or description
    (not "Send Ctrl+H (0x08) instead of Delete (0x7F)"). Describe the behavior a user sees
    ("Backspace deletes the whole previous word instead of one character").
  - Do not justify a platform-agnostic (or otherwise universal) default with platform-specific or
    otherwise scoped language ("...the way Windows terminals behave"). That justification stops
    holding the moment the default applies everywhere, leaving the copy subtly wrong. Keep the
    description true regardless of platform or context.

## Enforcement (self-maintaining)

- **Review:** `/code-review` flags these (Project Conventions list). Renderer changes trigger this
  rule's `src/renderer/**` auto-load; the copy convention on adapter files
  (`src/main/agent/adapters/**`) is caught by the always-on conventions finder instead, which runs
  regardless of which files changed.
- **Test (inline-SVG allowlist only):** `tests/unit/branding-assets.test.ts` asserts which
  branding asset each of the three exempt files imports, so the allowlist above is anchored to
  real imports rather than being a fourth list that drifts. It does not detect a NEW inline
  `<svg>` elsewhere; that stays review-caught.
- **Test (text selection):** `tests/unit/clickable-control-select-none.test.ts` parses the TSX AST
  under `src/renderer/**` and fails on a non-`button` element with an `onClick` and an action cursor
  whose className lacks `select-none`, unless it carries a `// select-none-ok: <reason>` marker. It
  parses rather than matching `<Tag ...>` with a regex, which truncates at the `>` inside
  `onClick={() => ...}` and so misses exactly the clickable elements. Two things keep it from
  passing vacuously: it pins the known exempt sites, so a parser change that stops resolving JSX is
  caught, and it drives the detector over known-bad source, so an `inScope` that stops matching is
  caught too. Runs in CI via `npm run test:unit`.
- **Test (chrome rows at the floor):** `tests/ui/toolbar-narrow-window.spec.ts` seeds a 400px
  sidebar, drives the board and backlog toolbars at 900x600 with the sidebar both expanded and
  collapsed, and sweeps every width across the ladder. It asserts four things, all read inside
  `page.evaluate` and all relative rather than pixel-exact: the row's height does not change
  between a wide viewport and the floor (a wrapped label is the only thing that can grow it), no
  control's right edge passes the row's content edge, the search field keeps a coarse minimum
  width, and the title bar's project name never reaches the icon cluster. It also asserts the
  labels ARE text at full width, which is what stops the whole spec passing vacuously: every
  collapse class is a min-width container query, so a variant that fails to compile leaves the
  row permanently icon-only, and an icon-only row trivially fits.

  **There is deliberately no static check here, and this is the gap.** Whether a row clips needs
  the runtime tree, so a scan cannot express it; the spec above is the only guard, and a new
  persistent chrome row is not covered until someone adds it there.
- The remaining bullets have no dedicated mechanical test yet. Candidate future checks: a scan for
  raw `<select>` and for `text-[10px]` (or smaller) under `src/renderer/`; a scan of
  `SETTINGS_REGISTRY` label/description fields for raw hex / byte-code literals (`0x`, `\x`, `\u`,
  `U+`).

## Scope

Renderer UI under `src/renderer/`. Does not govern marketing capture fixtures
(`tests/captures/`), which intentionally use their own font sizing for screenshots. The copy
convention also applies to adapter-authored setting copy in `src/main/agent/adapters/**`, reviewed
the same way when adapter files change.
