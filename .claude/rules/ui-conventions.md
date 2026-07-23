---
paths:
  - "src/renderer/**"
---
# Rule: renderer UI conventions

The renderer has shared primitives, selectors, and styling floors that keep the UI consistent,
readable, and testable. New UI code reintroduces raw elements, tiny fonts, and inconsistent
chrome unless these are stated.

## The rule

- **Icons:** use Lucide React icons. No inline SVGs.
- **Dropdowns:** use the shared `Select` component from
  `src/renderer/components/settings/shared.tsx`, never a raw `<select>` with inline classes.
  The shared component renders `appearance-none` with a custom ChevronDown for correct spacing.
- **Numeric counts:** use the shared `CountBadge` (`src/renderer/components/CountBadge.tsx`)
  with its `muted` / `accent` / `solid` variants. Do not inline badge styles.
- **Confirmations:** use `ConfirmDialog` for all yes/no prompts; set `showDontAskAgain` when the
  confirmation should be suppressible. Never build a one-off modal for a simple confirmation.
- **Dialog dismissal:** all dialogs use a global `useEffect` Escape key listener.
- **Test selectors:** add `data-testid` and `data-swimlane-name` attributes for test selectors.
- **Minimum font size:** default small text is `text-xs` (12px). The minimum is `text-[11px]`,
  reserved for very tight spaces (badges, column headers). Never `text-[10px]` or smaller
  without explicit approval. Empty states, descriptions, and hints use `text-sm` (14px) or larger.
- **Avoid hover-only controls for important actions.** Hover-revealed buttons
  (`opacity-0 group-hover:opacity-100`) get overlooked and exclude keyboard / touch users.
  Prefer a right-click context menu or an always-visible control; reserve inline visible buttons
  for the single most-used primary action. Default to visual subtraction over addition.
- **Brief, accurate copy for labels and descriptions.** State what the control does and what
  distinguishes it - purpose plus distinguishing behavior, the way task and PR descriptions are
  written. Plain language, no filler. Model: existing registry entries like "Lines kept in the
  visible scrollback. Full session history is preserved for replay regardless of this value."
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
- No dedicated mechanical test yet. Candidate future checks: a scan for raw `<select>` and for
  `text-[10px]` (or smaller) under `src/renderer/`; a scan of `SETTINGS_REGISTRY` label/description
  fields for raw hex / byte-code literals (`0x`, `\x`, `\u`, `U+`).

## Scope

Renderer UI under `src/renderer/`. Does not govern marketing capture fixtures
(`tests/captures/`), which intentionally use their own font sizing for screenshots. The copy
convention also applies to adapter-authored setting copy in `src/main/agent/adapters/**`, reviewed
the same way when adapter files change.
