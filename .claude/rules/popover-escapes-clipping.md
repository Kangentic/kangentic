---
paths:
  - "src/renderer/**"
---
# Rule: a menu popover portals out of its clipping ancestors

`z-index` does not escape an ancestor's overflow clip. A dropdown rendered in flow as
`absolute top-full ... z-50` is confined to the nearest `overflow: hidden` /
`overflow-y-auto` box, no matter how high its stacking order. This shipped twice: the Labels
field of the task-detail edit form, and then the Model / Agent / Effort / Permission
comboboxes in the same form, which showed only their first two options until the user
scrolled the form. The task-detail window alone nests three `overflow-hidden` ancestors above
one `overflow-y-auto` scroller, and the settings panel body, the board manager, the Import
dialog's raw body, `PopOutWindowFrame`, and every `DataTable` cell are clipping boxes too. A
menu inside a `<td>` is clipped to roughly one 40px table row.

## The rule

A popover that presents a list of choices (a menu, listbox, or picker) renders through a
`document.body` portal, positioned with a fixed strategy:

```tsx
const { style, placement } = usePopoverPosition(triggerRef, menuRef, open, {
  mode: 'dropdown', strategy: 'fixed',
});

<OverlayPopover open={open} popoverRef={menuRef} style={style} portal
  transformOrigin={placement.vertical === 'above' ? 'bottom center' : 'top center'}
  className="fixed z-[2147483646] ..." data-testid="...-menu">
```

Four things that are easy to get wrong, each of which fails silently:

- **Outside-click must check both refs.** The handler is a capture-phase `mousedown`; once the
  menu is portaled out of the trigger's subtree, a click inside it reads as "outside" and
  dismisses the menu. Check the menu ref **and** the container ref.
- **Keyboard navigation must query the menu ref**, not the container. A stale container query
  returns nothing, and since the arrow handler blurs the input first, focus lands on `<body>`
  and every subsequent key is dead.
- **`z-50` is wrong for a portaled element.** `BaseDialog` is itself `z-50`, and a body portal
  is its sibling. Use `z-[2147483646]`, as `LabelInput` and `KebabMenu` do.
- **Width and height caps do not survive.** `usePopoverPosition` writes only `top`/`left`, so
  `left-0 right-0` width matching is lost: measure the trigger in a `useLayoutEffect` and pass
  an explicit `width`. Keep the `max-h-*` cap on the portaled element, or a tall list fits
  neither below nor above, `openAbove` fires unconditionally, and `top` goes negative.

Two properties of the pattern to know before you reach for it, both shared with the existing
portaled sites (`LabelInput`, `KebabMenu`) rather than new:

- **The position is computed once, at open.** `usePopoverPosition` has no `scroll` or `resize`
  listener, so a `fixed` menu holds its viewport coordinates while its trigger moves. Scrolling
  the settings tab body, the task-detail edit form, the board-manager body, or a `DataTable`
  while a menu is open visually detaches it. Prefer a trigger that cannot scroll under an open
  menu; the `DataTable` sites partly self-heal, because virtualizing the anchor row out unmounts
  the popover with it.
- **`z-[2147483646]` clears the toast layer too.** Toasts render at `z-[60]`
  (`ToastContainer.tsx`), so a toast that fires while a portaled menu is open renders behind it.

`mode: 'flyout'` is exempt: the hook ignores `strategy` in flyout mode, so a flyout is
positioned against its parent and must already live inside a portaled parent (as
`TaskDetailHeader`'s submenus live inside `KebabMenu`'s).

A popover with no clipping ancestor at any mount site may stay in flow with a
`popover-inflow-ok: <reason>` comment naming the mount sites that were checked.

## Enforcement (self-maintaining)

- **Test (behavior, load-bearing):** two UI specs assert the structural invariant - that the
  menu is NOT a descendant of its clipping ancestor. `tests/ui/combobox-portal-clipping.spec.ts`
  covers Combobox / FontCombobox / ModelCombobox (the task-detail edit form at a short viewport)
  and `BranchPicker`'s `variant="input"` (Settings > Git), plus that the portal did not break
  outside-click, arrow-key navigation, or trigger-width matching.
  `tests/ui/popover-clipping-promote-restore-shortcuts.spec.ts` covers PromotePopover,
  RestorePopover, and ShortcutsTab's Presets menu. The structural assertion is the real guard:
  Playwright's `boundingBox()` and `toBeVisible()` both ignore overflow clipping, so a
  geometry-only check passes against a fully clipped menu.
- **Test (shape, tripwire):** `tests/unit/popover-inflow-menu.test.ts` scans `src/renderer/**`
  with TWO checks, and fails unless the site carries `popover-inflow-ok:`. Runs in CI via
  `npm run test:unit`.
  1. A `usePopoverPosition` call in `mode: 'dropdown'` that omits `strategy: 'fixed'`. This is
     the check that covers the common shape: in the default `'absolute'` strategy the hook
     writes `top`/`bottom: 100%` imperatively, so there is no positioning class to grep for.
     `mode: 'flyout'` never trips it, since the hook ignores `strategy` there.
  2. A class string that positions in flow (`absolute` + `top-full` / `bottom-full`) AND
     scrolls or caps its own height. This catches menus that never call the hook, which is why
     both checks exist - check 2 alone was blind to 8 of the 12 popovers this rule was written
     for, including a scrollable, height-capped one (`ToolBreakdownPopover`).

  Neither check can tell whether a mount site actually clips, which is why they are the
  tripwire and the UI specs are the guard.
- **Review:** `/code-review` flags a new in-flow menu on renderer changes.

## Scope

Choice-presenting popovers under `src/renderer/`. Does not govern tooltips (small, no scroll,
clipping is cosmetic), context menus (already `position: fixed` at the cursor), or floating
toolbars that are deliberately positioned inside their own pane.
