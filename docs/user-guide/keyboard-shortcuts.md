---
type: Guide
title: Keyboard shortcuts
description: Every default shortcut by area (general toggles, task detail, description editor, window snapping and dragging, terminal copy and paste), which ones are rebindable in Settings > Hotkeys, and which are fixed.
tags: [shortcuts, hotkeys, keybindings]
sources:
  - resource: src/shared/keybindings.ts
    title: KEYBINDINGS
---
# Keyboard shortcuts

Every shortcut is declared in a central registry, and nearly all are **rebindable** under Settings > Hotkeys, where each can be bound to a key chord or a mouse button (middle or side buttons). Hotkeys also flags conflicts and combos already claimed by the OS or another app. The description-editor keys below are the exception: they are **fixed**, because they are the platform conventions for text formatting. Fixed keys are still listed in Hotkeys for reference, just not editable. `Mod` below is Cmd on macOS and Ctrl on every other platform.

General:

- **Mod+Shift+S** - Toggle the settings panel
- **Mod+Shift+U** - Toggle the Usage Stats dashboard
- **Mod+Shift+A** - Toggle the Knowledge Graph (a map of what this project's conversation index has learned)
- **Mod+Shift+M** - Toggle the Agent Monitor (every running agent, across all projects)
- **Mod+Shift+B** - Switch between Board and Backlog view
- **Mod+Shift+L** - Open the Workflows view; pressed there, return to the view you came from
- **Mod+Shift+E** - Toggle the project sidebar
- **Mod+Shift+J** - Toggle the bottom terminal panel
- **Mod+Shift+P** - Toggle the Command Terminal window
- **Mod+Shift+F** - Open Quick Find (cross-project search palette)
- **Mod+F** - Find on board (focuses board search; opens Quick Find when not on the board)
- **Mod+N** - New Task on the board
- **Escape** - Close any open dialog or the search palette

Task detail (whichever panel is open):

- **Mod+Shift+M** - Maximize the command terminal, the task detail dialog (view or edit mode), or a create dialog (New Task / New Backlog Task)
- **Mod+Shift+W** - Close the command terminal, the task detail dialog, or a create dialog (New Task / New Backlog Task). Escape also closes any modal.
- **Mod+Shift+B** - Toggle the browser pane inside the task detail dialog
- **Mod+Shift+G** - Toggle the changes (diff) panel inside the task detail dialog
- **Mod+Shift+K** - Toggle the description panel inside the task detail dialog
- **Alt+Shift+Left** / **Alt+Shift+Right** - Move the open task one column left / right without closing its window. Stops at the first and last board columns; Done is never a target. Column automations and move confirmations apply exactly as they do for the kebab's "Move to"
- **Middle-click the window header** - Close a modeless task-detail window (default `Mouse:Middle`; routes through the same unsaved-edits guard as the close button)

Description editor (mounts in task detail and in the New Task / New Backlog Task dialogs). All four are fixed, not rebindable:

- **Mod+B** - Wrap the selected text in bold markdown
- **Mod+I** - Wrap the selected text in italic markdown
- **Mod+K** - Wrap the selected text in a markdown link
- **Mod+Shift+V** - Paste without converting pasted HTML to markdown. Not listed in Settings > Hotkeys, since no app lets you rebind it

Windows (modeless task-detail windows):

- **Mod+Shift+Left** / **Mod+Shift+Right** - Snap the focused window to the left / right half of the board area
- **Mod+Shift+Up** / **Mod+Shift+Down** - Stateful snap: Up maximizes a floating window and moves a half-snapped one to its top corner; Down restores a maximized window and moves a half-snapped one to its bottom corner
- **Drag by the header** - Wherever your cursor goes decides what happens: run it into the left, right or bottom edge of the board area to snap that half, into the top edge to maximize, or over another window to tile beside it. Over a window, the left and right thirds dock to that side at any height, and the middle third docks above or below depending on which half of the window you point at. Dragging onto another window only tiles once you have moved a fair distance, so a nudge just repositions; the screen edges arm as soon as the cursor reaches them.
- **Escape while dragging** - Abandon the drag: the window returns to where it started and nothing docks

Terminal:

- **Mod+C** / **Mod+Shift+C** - Copy selected text, stripping quote-bar decoration from any decorated lines (with no selection, Ctrl+C cancels the running command)
- **Mod+V** / **Mod+Shift+V** - Paste text or an image into the terminal
- Standard OS shortcuts for the rest of terminal editing
