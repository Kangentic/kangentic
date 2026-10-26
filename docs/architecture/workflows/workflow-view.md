---
type: Reference
title: Workflows view
description: "How the Workflows view is built: the lazy third BoardView that keeps @xyflow/react out of the eager bundle, the React Flow canvas, inspector and agent pane components, the single workflow-store, and how main's move lock is asked on the board so a refused card never slides."
tags: [workflows, renderer, canvas]
sources:
  - resource: src/renderer/components/workflows/
  - resource: src/renderer/stores/workflow-store.ts
  - resource: src/renderer/components/board/WorkflowTaskCardBody.tsx
  - resource: src/renderer/components/board/WorkflowLinksOverlay.tsx
  - resource: src/renderer/utils/board-workflow.ts
  - resource: src/shared/workflow-lock.ts
---
# Workflows view

The view is the third `BoardView` (`'board' | 'backlog' | 'workflows'`), loaded on first open
(`LazyWorkflowsView`), so `@xyflow/react` stays out of the eager bundle; `scripts/build.js` fails a
build where it is reachable by a static import.

```
src/renderer/components/workflows/
  WorkflowsView.tsx        # header, agent pane, canvas, inspector, dialogs, the canvas card menu
  WorkflowAgentPane.tsx    # the workflow agent's terminal, Pause / Resume, and the plan hold while it works
  WorkflowHeader.tsx       # picker, Rename, Start / Running / Resume, Delete, progress (a width ladder)
  WorkflowCanvas.tsx       # React Flow: nodes, lane-routed edges, tools, search hiding
  WorkflowTaskNode.tsx     # one card: ports, the full-card link target, the drop hint
  WorkflowCanvasCard.tsx   # the board's card body under the workflow strip, as tall as its content
  canvas-card-heights.ts   # each card's measured height for the layout; an estimate until measured
  canvas-arrange.ts        # what Auto layout moved, so those cards slide and their links hide meanwhile
  WorkflowInspector.tsx    # run order, a task's plan approval, route rail, links, Add blocker, footer (canvas and task detail)
  WorkflowCardMenu.tsx     # the board's TaskContextMenu with Open on board
  TaskWorkflowPanel.tsx    # task detail's workflow panel: the inspector for the task's own workflow
  WorkflowPicker.tsx       # the header's picker, and the workflow state chip
  WorkflowDialogs.tsx      # Start, Delete, Remove and Rename confirms
  WorkflowStrip.tsx        # the strip on a card (canvas and board) and its step track
  workflow-track.ts        # pure: the track's stops, the board's To Do, the route, the board's Done
  WorkflowEdge.tsx         # a link through the lanes between columns; a selected task's links flow
  workflow-canvas-context.ts # the workflow a node reads for its link hint
  workflow-graph.ts        # pure: waiting, link and route guards, run order
  workflow-layout.ts       # pure: the layered auto layout
src/renderer/components/board/
  WorkflowTaskCardBody.tsx # a workflow task's board card: the strip, and the To Do footer
  card-links-preview.ts    # a 400ms rest on a workflow card previews its links; a press on it holds them through the drag and after the drop while the pointer stays on it
  WorkflowLinksOverlay.tsx # a card's links: the canvas's flowing lines and title-row ports, clipped below the header row, re-measured on scroll, resize, card height and every frame of its card's drag; trimmed, ringed and bordered as the canvas draws a selected card's, faded in and out
  workflow-menu-items.tsx  # Open workflow, in the card menu's navigationItem slot
  DeleteTaskDialog.tsx     # the Delete task confirm, shared by the board card and the canvas menu
src/renderer/utils/
  board-workflow.ts        # a card's workflow facts from the summaries, and the lock asked on the board
  motion-reduced.ts        # the Animations setting (or the web build's reduced motion), read when a motion starts
  workflow-refusal.ts      # a refused move: main's sentence, a click that opens the workflow, the links overlay
```

- **One store** (`workflow-store.ts`): the project's summaries (each carries `boardTasks`, every
  card's waiting-for, human-gate exit and whether it has links), other projects' summaries for cards on this board, the
  selected workflow's detail, task panels' watched details, and the links overlay. Edits address a
  workflow by home project and id (`setRouteIn`, `setLinkIn`, `removeTaskIn`), so task detail acts
  on the task's own workflow whatever the view shows. A reload keeps unchanged objects
  (`shareUnchanged`, `shareSummaries`), so a move re-renders only the cards it changed.
- **The lock on the board** is main's own predicate (`src/shared/workflow-lock.ts`), asked by the
  drop and by `moveTask` before the card moves, so a refused card never slides and snaps back.
  A card only its workflow moves (`isLockedOnBoard`) is held to its column for the whole drag
  (`useBoardDragDrop`: its collisions see only that column's cards, and a modifier keeps it from
  moving sideways), so it can be reordered there and never reaches another column. Main still
  refuses on its own for every other path.
- **An ordinary card pays nothing:** only a task with `workflow_id` mounts `WorkflowTaskCardBody`,
  which holds the workflow subscriptions.
