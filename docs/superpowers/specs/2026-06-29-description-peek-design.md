# Design: Description Peek While Task Is In Progress

**Date:** 2026-06-29
**Branch:** add-easier-way-to-vi-1ff6792c

## Problem

Once a task is in progress and the terminal/activity view takes over the task detail dialog, the
ticket description is no longer visible. The `descriptionBar` in `TaskDetailBody` is guarded by
`&& !hasSessionContext`, so it evaluates to null the moment a session starts. Users must leave the
running view and enter edit mode to re-read what the task is about.

## Goal

Provide a quick, low-friction way to view the task description while the terminal is active,
without tearing down or duplicating the running PTY session.

## Chosen Approach: "Description" header pill

Mirror the existing "Changes" and "Browser" toggle pills in the task detail header. When toggled
on, a height-capped, scrollable description strip appears above the terminal. The terminal resizes
to fill the remaining space. Toggling off removes the strip. No IPC, no new store slice, no
persistence.

## Architecture

### State

`descriptionPeekOpen: boolean` is a plain `useState(false)` in `TaskDetailWindow.tsx`.

Not stored in the session store or `TaskDetailViewState` because the peek is transient: the user
glances at the brief while working, then closes it. Persisting it would reopen the dialog with the
terminal already pushed down, which would be surprising.

`canShowDescription` is derived in `TaskDetailWindow` as:

```ts
const hasDescriptionContent =
  !!(task.description || attachments.savedAttachments.length > 0
    || (task.priority ?? 0) > 0 || (task.labels ?? []).length > 0);
const canShowDescription = hasSessionContext && hasDescriptionContent;
```

The pill and keybinding are invisible when there is nothing to show (no description, no
attachments, no labels/priority) or when the description is already visible in the non-session
view.

### Keybinding

New entry in `src/shared/keybindings.ts`:

```ts
{
  id: 'taskDetail.toggleDescription',
  label: 'Toggle Description Peek',
  description: 'Show or hide the description strip above the terminal in the task detail dialog.',
  group: 'Task Detail',
  scope: 'task-dialog',
  defaultCombo: 'Mod+Shift+I',
  rebindable: true,
}
```

Placed after `taskDetail.toggleChanges`. Bound in `TaskDetailWindow` via `useKeybinding` gated on
`isFocused && canShowDescription` (capture phase, consistent with other task-detail bindings).

### Header pill (`TaskDetailHeader.tsx`)

Three new props: `canShowDescription: boolean`, `descriptionPeekOpen: boolean`,
`onToggleDescription: () => void`.

New pill spec entry in `pillSpecs`:

```ts
if (canShowDescription) specs.push({ id: 'description', priority: 45 });
```

Priority 45 sits between Commands (50) and Folder (40), so the description pill folds into the
kebab before folder/worktree access does on narrow windows.

Pill JSX (mirrors Changes/Browser pattern):

- Icon: `AlignLeft` (Lucide - reads as "content/text", distinct from existing pills)
- Active class: `bg-accent/15 text-accent-fg border-accent/30`
- Title attribute: includes the formatted `Mod+Shift+I` combo via `useFormattedCombo`
- `data-testid="description-peek-toggle"`

Kebab item added to `TaskDetailKebabItems` between Changes and Browser items:

```tsx
{canShowDescription && (
  <KebabMenuItem
    icon={<AlignLeft size={14} />}
    label={descriptionPeekOpen ? 'Hide description' : 'Show description'}
    onClick={() => { closeAll(); onToggleDescription(); }}
  />
)}
```

### Body panel (`TaskDetailBody.tsx`)

One new prop: `descriptionPeekOpen: boolean`.

The `descriptionBar` constant changes its guard and gains a conditional height cap:

**Before:**
```tsx
const descriptionBar = !isArchived
  && (task.description || savedAttachments.length > 0 || hasLabelsOrPriority)
  && !hasSessionContext && (
  <div className="px-4 py-3 border-b border-edge flex-shrink-0 space-y-2">
    ...
  </div>
);
```

**After:**
```tsx
const descriptionBar = !isArchived
  && (task.description || savedAttachments.length > 0 || hasLabelsOrPriority)
  && (!hasSessionContext || descriptionPeekOpen) && (
  <div className={`px-4 py-3 border-b border-edge flex-shrink-0 space-y-2${
    hasSessionContext ? ' max-h-[25vh] overflow-y-auto' : ''
  }`}>
    {task.description && <MarkdownRenderer content={task.description} />}
    {labelsAndPriorityRow}
    {thumbnailStrip}
  </div>
);
```

No other body branches change. The active-session return path already renders `{descriptionBar}`
at the top - when `descriptionPeekOpen` becomes true, the bar reappears and the terminal flex-1
div absorbs the height change. `flex-shrink-0` on the bar ensures the terminal shrinks, not the
bar. The `preparing` branch already renders `{descriptionBar}`, so the peek works there for free.

### Prop threading (`TaskDetailWindow.tsx`)

`TaskDetailWindow` is the orchestrator. It owns the new state and passes props down:

- `TaskDetailHeader` receives: `canShowDescription`, `descriptionPeekOpen`,
  `onToggleDescription: () => setDescriptionPeekOpen((open) => !open)`
- `TaskDetailBody` receives: `descriptionPeekOpen`

## Files Changed

| File | Change |
|---|---|
| `src/shared/keybindings.ts` | Add `taskDetail.toggleDescription` entry |
| `src/renderer/window-manager/components/TaskDetailWindow.tsx` | Add state, keybinding, prop threading |
| `src/renderer/components/dialogs/task-detail/TaskDetailHeader.tsx` | Add pill, kebab item, 3 new props |
| `src/renderer/components/dialogs/task-detail/TaskDetailBody.tsx` | Modify `descriptionBar` guard + max-h, 1 new prop |

## Acceptance Criteria

- [ ] Description is viewable from the in-progress task view (terminal active)
- [ ] Does not tear down or duplicate the running PTY/terminal
- [ ] Peek is height-capped at 25vh and scrollable when content is tall
- [ ] Pill only appears when there is content to show (description, attachments, labels, or priority)
- [ ] Pill collapses into kebab overflow on narrow windows (automatic via pill overflow system)
- [ ] Keybinding `Mod+Shift+I` toggles the peek when the task dialog is focused
- [ ] Kebab menu item mirrors the pill action
- [ ] No change to archived, queued, suspended, or changes-only body branches

## Non-Goals

- No persistence of the open/closed state across dialog close/reopen
- No IPC changes
- No new Zustand store slice
- No change to the "preparing" branch (it already gets the peek for free)
