---
type: Audit
title: Test suite inventory
description: "One row per test file on 2026-11-02, the classification behind the test suite audit: tests, CI seconds, commits, reds by class, the rule that names it, and a verdict with its reason. Every row defaults to keep unless a family review or the evidence said otherwise."
tags: [audit, testing, ci]
---
# Test suite inventory (2026-11-02)

The classification behind the [test suite audit](test-suite-audit.md). Times come from CI run
41391402821. Commits count every commit that touched the file. Reds count 90 red CI attempts over
52 days, as flake, then tests-only fix, then a change that touched `src/`. Rule names the
`.claude/rules/` file that cites the test as enforcement, so removing it changes that rule.

Each row shows the file as it stood on that date, with what the audit then did to it, so a file later
removed keeps its row. Keep is the default: a test with no signal against it stays, because a rarely
red test can still guard an expensive miss.

| File | Tests | CI seconds | Commits | Reds (flake/tests/product) | Rule | Verdict | Reason |
|---|---:|---:|---:|---|---|---|---|
| demo/static-demo.spec.ts | 292 | 944 | 71 | 1/5/2 | web-demo-parity | keep | named as a rule enforcement |
| demo/heap-budget.spec.ts | 2 | 19 | 1 | 0/0/0 | web-demo-parity | keep | named as a rule enforcement |
| demo/demo-boot-contract.spec.ts | 13 | 8 | 5 | 0/0/0 |  | keep | no signal against it |
| e2e/agent-session-id-capture.spec.ts | 6 | 55 | 6 | 0/0/0 |  | keep | no signal against it |
| e2e/browser-evidence-retry.spec.ts | 3 | 45 | 6 | 0/0/0 |  | keep | no signal against it |
| e2e/agent-session-resume.spec.ts | 6 | 35 | 5 | 0/0/0 |  | keep | no signal against it |
| e2e/browser-popup-window.spec.ts | 3 | 33 | 3 | 0/0/0 | agent-driven-focus | keep | named as a rule enforcement |
| e2e/session-resume-os-killed.spec.ts | 1 | 33 | 5 | 0/0/0 |  | keep | no signal against it |
| e2e/session-reconciliation.spec.ts | 1 | 32 | 8 | 0/0/0 |  | keep | no signal against it |
| e2e/session-resume.spec.ts | 4 | 32 | 15 | 0/0/0 | command-terminal | keep | named as a rule enforcement |
| e2e/workflow-engine.spec.ts | 4 | 32 | 2 | 0/1/1 |  | keep | red with a product change in the window |
| e2e/agent-activity-special-modes.spec.ts | 4 | 30 | 6 | 1/0/0 |  | keep | no signal against it |
| e2e/browser-agent-key-focus.spec.ts | 2 | 25 | 1 | 0/0/0 | agent-driven-focus | keep | named as a rule enforcement |
| e2e/kimi-concurrent-spawns.spec.ts | 1 | 21 | 4 | 0/0/0 |  | keep | no signal against it |
| e2e/task-delete.spec.ts | 4 | 18 | 24 | 0/0/0 |  | keep | no signal against it |
| e2e/session-model-name.spec.ts | 3 | 17 | 4 | 0/0/0 |  | keep | no signal against it |
| e2e/codex-activity-detection.spec.ts | 2 | 16 | 10 | 0/0/0 |  | keep | no signal against it |
| e2e/session-no-false-resume.spec.ts | 2 | 16 | 7 | 0/0/0 |  | keep | no signal against it |
| e2e/browser-ctrl-enter-pty.spec.ts | 1 | 15 | 2 | 0/0/0 |  | keep | no signal against it |
| e2e/turn-end-automation.spec.ts | 2 | 15 | 2 | 0/0/0 |  | keep | no signal against it |
| e2e/browser-send-roundtrip.spec.ts | 1 | 14 | 3 | 0/0/0 |  | keep | no signal against it |
| e2e/cursor-activity-detection.spec.ts | 4 | 14 | 8 | 0/0/0 |  | keep | no signal against it |
| e2e/background-shell-idle.spec.ts | 3 | 13 | 6 | 2/0/0 |  | keep | no signal against it |
| e2e/browser-cdp-navigation.spec.ts | 1 | 13 | 3 | 0/0/0 |  | keep | no signal against it |
| e2e/session-resume-expired.spec.ts | 2 | 13 | 2 | 0/0/0 |  | keep | no signal against it |
| e2e/claude-activity-detection.spec.ts | 11 | 12 | 8 | 0/0/0 |  | trimmed | 4 event-bridge cases run no Electron |
| e2e/project-delete.spec.ts | 3 | 11 | 7 | 0/0/0 |  | keep | no signal against it |
| e2e/session-queue.spec.ts | 2 | 11 | 9 | 1/0/0 |  | keep | no signal against it |
| e2e/task-process-reap.spec.ts | 1 | 11 | 3 | 0/0/0 |  | keep | no signal against it |
| e2e/session-move-lifecycle.spec.ts | 6 | 10 | 13 | 0/0/0 |  | keep | no signal against it |
| e2e/terminal-fit-invariant.spec.ts | 1 | 10 | 4 | 0/0/1 |  | keep | red with a product change in the window |
| e2e/copilot-activity-detection.spec.ts | 3 | 9 | 5 | 0/0/0 |  | keep | no signal against it |
| e2e/grok-activity-detection.spec.ts | 2 | 9 | 2 | 0/0/0 |  | keep | no signal against it |
| e2e/kimi-activity-detection.spec.ts | 3 | 9 | 8 | 0/0/0 |  | keep | no signal against it |
| e2e/opencode-activity-detection.spec.ts | 3 | 9 | 5 | 0/0/0 |  | keep | no signal against it |
| e2e/terminal-fullscreen-select-replay-focus.spec.ts | 1 | 9 | 9 | 0/0/1 |  | keep | red with a product change in the window |
| e2e/session-rapid-moves.spec.ts | 2 | 8 | 10 | 0/0/0 |  | keep | no signal against it |
| e2e/task-prompt.spec.ts | 3 | 8 | 11 | 1/0/0 |  | keep | no signal against it |
| e2e/config-changes.spec.ts | 1 | 7 | 10 | 0/1/0 |  | keep | no signal against it |
| e2e/done-worktree-lifecycle.spec.ts | 2 | 7 | 4 | 0/0/0 |  | keep | no signal against it |
| e2e/terminal-input-second-renderer.spec.ts | 1 | 7 | 1 | 1/0/0 | pty-host-out-of-process | keep | named as a rule enforcement |
| e2e/warp-activity-detection.spec.ts | 2 | 7 | 7 | 0/0/0 |  | keep | no signal against it |
| e2e/column-agent-limit.spec.ts | 3 | 6 | 1 | 0/0/0 |  | keep | no signal against it |
| e2e/terminal-width-drift-selfheal.spec.ts | 1 | 6 | 3 | 0/0/1 |  | keep | red with a product change in the window |
| e2e/window-light-dismiss-pty-survival.spec.ts | 1 | 6 | 3 | 0/0/0 |  | keep | no signal against it |
| e2e/bulk-delete-worktrees.spec.ts | 1 | 5 | 4 | 0/0/0 |  | keep | no signal against it |
| e2e/command-terminal-reload-recovery.spec.ts | 1 | 5 | 2 | 0/0/0 |  | keep | no signal against it |
| e2e/conversation-memory-search.spec.ts | 1 | 4 | 3 | 0/0/0 |  | keep | no signal against it |
| e2e/gemini-activity-detection.spec.ts | 1 | 4 | 4 | 0/0/0 |  | keep | no signal against it |
| e2e/session-exit.spec.ts | 2 | 4 | 9 | 0/0/0 |  | keep | no signal against it |
| e2e/terminal-rendering.spec.ts | 1 | 4 | 11 | 0/0/0 |  | keep | no signal against it |
| e2e/usage-history-survives-delete.spec.ts | 1 | 4 | 4 | 0/0/0 |  | keep | no signal against it |
| e2e/devtools-inspection.spec.ts | 0 | 0 | 5 | 0/0/0 |  | keep | no signal against it |
| e2e/os-reduced-motion.spec.ts | 1 | 0 | 1 | 0/0/0 | activity-marks | keep | named as a rule enforcement |
| ui/command-terminal.spec.ts | 135 | 943 | 64 | 7/1/2 | activity-marks command-terminal | trimmed | 4 removed, 2 folded |
| ui/knowledge-graph.spec.ts | 112 | 458 | 12 | 1/1/0 |  | moved down | 5 moved; the :2380 removal was dropped, since no unit test pins its gate |
| ui/agent-monitor.spec.ts | 61 | 353 | 20 | 0/0/0 |  | trimmed | 1 removed |
| ui/workflows-view.spec.ts | 58 | 339 | 15 | 0/0/0 |  | trimmed | 1 removed, 2 folded |
| ui/completed-task-view.spec.ts | 57 | 292 | 16 | 0/1/0 |  | keep | 15 tests need an extraction first |
| ui/workflows-board.spec.ts | 50 | 257 | 11 | 0/0/0 |  | keep | no signal against it |
| ui/task-detail-maximize.spec.ts | 28 | 234 | 27 | 8/1/1 | command-terminal | keep | named as a rule enforcement |
| ui/workflow-agent-pane.spec.ts | 35 | 201 | 7 | 1/0/0 |  | keep | no signal against it |
| ui/onboarding-walkthrough.spec.ts | 32 | 183 | 11 | 0/0/0 |  | keep | 2 tests need an extraction first |
| ui/command-terminal-rail.spec.ts | 16 | 180 | 6 | 1/1/1 | command-terminal | keep | named as a rule enforcement |
| ui/usage-dashboard.spec.ts | 30 | 170 | 25 | 0/0/0 |  | trimmed | 1 removed |
| ui/task-activity-indicators.spec.ts | 45 | 161 | 56 | 0/0/1 |  | keep | 7 tests need an extraction first |
| ui/project-groups.spec.ts | 26 | 150 | 8 | 0/0/0 |  | keep | no signal against it |
| ui/task-automations-disabled.spec.ts | 25 | 133 | 5 | 0/0/0 |  | moved down | 1 test, mock harness |
| ui/browser-pane-agent-input-focus.spec.ts | 24 | 119 | 7 | 0/0/0 | agent-driven-focus | keep | named as a rule enforcement |
| ui/import-filter.spec.ts | 26 | 119 | 13 | 0/0/0 |  | keep | 7 tests need an extraction first |
| ui/conversation-route-tabs.spec.ts | 24 | 115 | 4 | 0/0/0 |  | trimmed | 1 removed |
| ui/backlog.spec.ts | 23 | 112 | 12 | 0/0/0 |  | keep | 4 tests need an extraction first |
| ui/sidebar-command-terminals.spec.ts | 30 | 111 | 11 | 0/0/0 | command-terminal | trimmed | 2 removed, 1 folded; :819 stays, its guard is inline in App.tsx |
| ui/conversation-viewer.spec.ts | 21 | 110 | 8 | 0/0/0 |  | keep | no signal against it |
| ui/completed-task-changes.spec.ts | 15 | 109 | 3 | 1/0/0 |  | keep | no signal against it |
| ui/model-picker-aliases.spec.ts | 34 | 109 | 8 | 0/1/0 |  | keep | no signal against it |
| ui/dictation-note-input.spec.ts | 28 | 108 | 6 | 0/0/0 | agent-driven-focus | trimmed | 1 removed |
| ui/agent-driven-invalidation.spec.ts | 16 | 106 | 8 | 0/0/0 |  | keep | no signal against it |
| ui/dictation-settings-models.spec.ts | 21 | 101 | 7 | 1/0/0 |  | trimmed | 1 folded, loop cut |
| ui/conversation-paging.spec.ts | 18 | 95 | 7 | 0/0/0 |  | keep | no signal against it |
| ui/cycle-shortcuts.spec.ts | 17 | 95 | 2 | 0/0/0 |  | keep | no signal against it |
| ui/dialog-save-hotkey.spec.ts | 20 | 95 | 1 | 0/0/0 |  | keep | no signal against it |
| ui/tooltip-behaviour.spec.ts | 22 | 93 | 4 | 0/0/0 |  | keep | no signal against it |
| ui/column-agent-limit.spec.ts | 17 | 87 | 1 | 0/0/0 |  | keep | no signal against it |
| ui/embedding-model-picker.spec.ts | 22 | 87 | 14 | 0/0/0 |  | keep | no signal against it |
| ui/workflows-canvas-gestures.spec.ts | 15 | 86 | 5 | 0/0/0 |  | keep | no signal against it |
| ui/search-palette.spec.ts | 18 | 82 | 12 | 0/0/0 |  | keep | no signal against it |
| ui/board-cross-column-drop-gap.spec.ts | 16 | 81 | 3 | 0/0/0 |  | keep | no signal against it |
| ui/command-terminal-rename.spec.ts | 12 | 80 | 3 | 0/0/0 | command-terminal | keep | named as a rule enforcement |
| ui/task-level-overrides.spec.ts | 55 | 78 | 27 | 0/0/1 |  | keep | red with a product change in the window |
| ui/monaco-error-funnel.spec.ts | 11 | 76 | 3 | 0/0/0 |  | keep | no signal against it |
| ui/activity-marks.spec.ts | 12 | 74 | 7 | 0/0/0 | activity-marks | keep | named as a rule enforcement |
| ui/popover-first-open-alignment.spec.ts | 12 | 72 | 6 | 0/0/0 | popover-escapes-clipping | keep | named as a rule enforcement |
| ui/project-sidebar-actions.spec.ts | 13 | 72 | 9 | 0/0/0 |  | keep | no signal against it |
| ui/toolbar-narrow-window.spec.ts | 19 | 70 | 8 | 0/0/0 | ui-conventions | keep | named as a rule enforcement |
| ui/move-to-done-confirm.spec.ts | 13 | 69 | 11 | 0/0/0 |  | keep | no signal against it |
| ui/stop-script-setting.spec.ts | 13 | 69 | 4 | 0/0/0 |  | keep | no signal against it |
| ui/project-session-scope.spec.ts | 13 | 67 | 21 | 0/0/0 |  | keep | no signal against it |
| ui/task-detail-changes-image-diff.spec.ts | 29 | 67 | 11 | 0/1/0 |  | keep | no signal against it |
| ui/task-menu-session-toggle-hosts.spec.ts | 15 | 66 | 3 | 0/0/0 |  | keep | no signal against it |
| ui/settings-panel.spec.ts | 60 | 65 | 79 | 0/1/0 |  | keep | no signal against it |
| ui/leftover-processes.spec.ts | 19 | 63 | 8 | 0/0/0 | task-process-tag | keep | named as a rule enforcement |
| ui/monitor-confirm-and-detail-writes.spec.ts | 9 | 63 | 2 | 0/0/0 |  | keep | no signal against it |
| ui/monitor-writes-reach-board.spec.ts | 11 | 62 | 3 | 0/0/0 |  | keep | no signal against it |
| ui/task-detail-close-on-pause.spec.ts | 10 | 61 | 7 | 0/0/0 |  | keep | no signal against it |
| ui/agent-tab-remote-execution.spec.ts | 10 | 58 | 9 | 0/0/0 |  | keep | no signal against it |
| ui/board-keyboard-drag-intent.spec.ts | 13 | 58 | 8 | 0/0/0 | keyboard-drag-intent | keep | named as a rule enforcement |
| ui/browser-pane-shortcuts.spec.ts | 15 | 58 | 11 | 0/0/0 |  | keep | no signal against it |
| ui/display-language.spec.ts | 17 | 58 | 4 | 0/0/0 |  | keep | no signal against it |
| ui/graphics-recovery.spec.ts | 16 | 58 | 4 | 0/0/0 |  | keep | no signal against it |
| ui/changes-commit-selection-bar.spec.ts | 5 | 57 | 1 | 0/0/0 | keybindings-registry | keep | named as a rule enforcement |
| ui/terminal-panel-reveal.spec.ts | 14 | 56 | 4 | 0/0/0 |  | keep | no signal against it |
| ui/command-terminal-earlier.spec.ts | 8 | 55 | 2 | 1/0/0 |  | keep | no signal against it |
| ui/edit-automation-guards.spec.ts | 39 | 54 | 11 | 0/0/0 |  | keep | no signal against it |
| ui/onboarding-welcome-screen.spec.ts | 13 | 53 | 7 | 0/0/1 |  | keep | red with a product change in the window |
| ui/agent-tab-auth-warning.spec.ts | 8 | 49 | 9 | 0/0/0 |  | keep | no signal against it |
| ui/archived-context-menu.spec.ts | 11 | 48 | 6 | 0/0/0 |  | keep | no signal against it |
| ui/board-manager-automations.spec.ts | 26 | 48 | 12 | 0/0/0 |  | keep | no signal against it |
| ui/diff-swap-stale-view-model.spec.ts | 4 | 47 | 1 | 0/0/0 |  | keep | no signal against it |
| ui/mobile-devices-settings.spec.ts | 48 | 47 | 21 | 1/0/0 |  | keep | no signal against it |
| ui/agent-auth-warning.spec.ts | 11 | 46 | 6 | 0/0/0 |  | keep | no signal against it |
| ui/automation-run-again-toast.spec.ts | 10 | 46 | 2 | 0/0/0 |  | keep | no signal against it |
| ui/release-notes-modal.spec.ts | 9 | 46 | 3 | 0/0/0 |  | keep | no signal against it |
| ui/tooltip.spec.ts | 11 | 46 | 3 | 0/0/0 | keybindings-registry one-tooltip | keep | named as a rule enforcement |
| ui/column-icon-catalog.spec.ts | 9 | 45 | 1 | 0/0/0 |  | keep | no signal against it |
| ui/window-drag-free-move.spec.ts | 8 | 45 | 3 | 0/0/0 |  | keep | no signal against it |
| ui/changes-diff-scroll-memory.spec.ts | 8 | 44 | 16 | 0/1/0 |  | keep | no signal against it |
| ui/popover-clipping-promote-restore-shortcuts.spec.ts | 9 | 44 | 2 | 0/0/0 | popover-escapes-clipping | keep | named as a rule enforcement |
| ui/idle-toast.spec.ts | 11 | 43 | 5 | 0/0/0 |  | trimmed | 2 loop cases cut |
| ui/plan-approval-controls.spec.ts | 8 | 43 | 4 | 0/0/0 |  | keep | no signal against it |
| ui/workflow-planned-task-form.spec.ts | 7 | 43 | 4 | 0/0/0 |  | keep | no signal against it |
| ui/project-sidebar-search.spec.ts | 6 | 42 | 3 | 1/0/0 |  | keep | no signal against it |
| ui/move-to-done-completion-store.spec.ts | 8 | 40 | 6 | 0/0/0 |  | moved down | 6 tests to a new slice test |
| ui/add-project-flow.spec.ts | 8 | 39 | 5 | 0/0/0 |  | keep | no signal against it |
| ui/asana-auth.spec.ts | 7 | 39 | 3 | 0/0/0 |  | keep | no signal against it |
| ui/browser-pane-active.spec.ts | 10 | 38 | 4 | 0/0/0 |  | keep | no signal against it |
| ui/host-memory-agent-paused.spec.ts | 11 | 38 | 5 | 0/0/0 |  | keep | no signal against it |
| ui/terminal-image-paste-reference.spec.ts | 10 | 38 | 4 | 0/0/0 |  | keep | no signal against it |
| ui/collapsed-rail.spec.ts | 10 | 37 | 9 | 0/0/0 |  | keep | no signal against it |
| ui/setting-text-input-commit.spec.ts | 7 | 37 | 3 | 1/0/0 |  | keep | no signal against it |
| ui/workflows-canvas.spec.ts | 7 | 37 | 3 | 0/0/0 |  | keep | no signal against it |
| ui/workflows-canvas-card-fit.spec.ts | 6 | 36 | 2 | 0/0/0 |  | keep | no signal against it |
| ui/move-to-todo-confirm.spec.ts | 6 | 35 | 7 | 0/0/0 |  | keep | no signal against it |
| ui/new-task-dialog.spec.ts | 28 | 35 | 15 | 0/1/0 |  | keep | no signal against it |
| ui/window-click-outside-close.spec.ts | 20 | 35 | 10 | 0/0/0 | light-dismiss-denylist | keep | named as a rule enforcement |
| ui/bulk-delete-failures.spec.ts | 5 | 34 | 6 | 0/0/0 |  | keep | no signal against it |
| ui/delete-task-optimistic.spec.ts | 7 | 34 | 4 | 0/0/0 |  | keep | no signal against it |
| ui/task-detail-changes-diffviewer-toolbar.spec.ts | 12 | 34 | 15 | 0/0/0 |  | keep | no signal against it |
| ui/toast-behavior.spec.ts | 11 | 34 | 4 | 0/0/0 | toast-shape | keep | named as a rule enforcement |
| ui/conversation-search.spec.ts | 7 | 33 | 2 | 0/0/0 |  | trimmed | 1 removed |
| ui/dictation-live-chip.spec.ts | 11 | 33 | 4 | 0/0/0 |  | trimmed | 1 removed, 1 folded |
| ui/settings-project-target.spec.ts | 8 | 33 | 3 | 0/0/0 |  | keep | no signal against it |
| ui/combobox-portal-clipping.spec.ts | 6 | 32 | 4 | 0/0/0 | popover-escapes-clipping | keep | named as a rule enforcement |
| ui/task-menu-session-toggle.spec.ts | 9 | 32 | 4 | 0/0/0 |  | keep | no signal against it |
| ui/terminal-resize-echo-reassert.spec.ts | 7 | 32 | 5 | 0/0/0 |  | keep | no signal against it |
| ui/toast-click-through.spec.ts | 10 | 32 | 5 | 0/0/0 | toast-shape | keep | named as a rule enforcement |
| ui/board-manager-dialog-ext.spec.ts | 28 | 31 | 22 | 0/0/0 |  | trimmed | 1 removed |
| ui/board-manager-dialog.spec.ts | 19 | 31 | 13 | 0/0/0 |  | trimmed | 1 folded |
| ui/browser-pane-hold-on-hide.spec.ts | 7 | 31 | 2 | 0/0/0 | retained-pane-never-remounts | keep | named as a rule enforcement |
| ui/combobox-current-row-check.spec.ts | 5 | 31 | 1 | 0/0/0 |  | keep | no signal against it |
| ui/task-detail-save-hotkey.spec.ts | 18 | 31 | 1 | 0/0/0 |  | keep | no signal against it |
| ui/settings-write-failure-toast.spec.ts | 6 | 30 | 7 | 0/1/0 |  | keep | no signal against it |
| ui/terminal-held-grid-conform.spec.ts | 7 | 30 | 6 | 1/0/0 | web-demo-parity | keep | named as a rule enforcement |
| ui/agent-tab-launch-options.spec.ts | 5 | 29 | 6 | 0/0/0 |  | keep | no signal against it |
| ui/browser-offscreen-surface.spec.ts | 6 | 29 | 3 | 0/0/0 | browser-automation-driver | keep | named as a rule enforcement |
| ui/browser-pane-jar-sync-gate.spec.ts | 5 | 29 | 3 | 0/0/0 |  | keep | no signal against it |
| ui/controls-have-names.spec.ts | 4 | 29 | 4 | 0/0/0 | one-tooltip | keep | named as a rule enforcement |
| ui/combobox-escape-layering.spec.ts | 4 | 28 | 5 | 0/0/0 | keybindings-registry | keep | named as a rule enforcement |
| ui/feature-usage-telemetry.spec.ts | 7 | 28 | 3 | 0/0/0 |  | keep | no signal against it |
| ui/browser-pane-viewport-chip.spec.ts | 7 | 27 | 2 | 0/0/0 |  | keep | no signal against it |
| ui/browser-pop-out-pane.spec.ts | 7 | 27 | 1 | 0/0/0 | browser-automation-driver | keep | named as a rule enforcement |
| ui/context-bar-effort.spec.ts | 6 | 27 | 4 | 0/0/0 |  | keep | no signal against it |
| ui/context-bar-tool-breakdown.spec.ts | 19 | 27 | 13 | 0/0/0 | popover-escapes-clipping | keep | named as a rule enforcement |
| ui/spawn-stall-toast.spec.ts | 7 | 27 | 7 | 0/0/0 |  | keep | no signal against it |
| ui/task-detail-split-divider.spec.ts | 15 | 27 | 9 | 0/0/0 |  | keep | no signal against it |
| ui/context-bar-popover.spec.ts | 13 | 26 | 13 | 0/0/0 | popover-escapes-clipping | keep | named as a rule enforcement |
| ui/settings-pausing-agents.spec.ts | 6 | 26 | 1 | 0/0/0 |  | keep | no signal against it |
| ui/whats-new-dialog.spec.ts | 8 | 26 | 4 | 0/0/0 |  | keep | no signal against it |
| ui/write-batcher-integration.spec.ts | 5 | 26 | 8 | 0/0/0 |  | keep | no signal against it |
| ui/commit-detail-selection.spec.ts | 4 | 25 | 6 | 0/0/0 |  | keep | no signal against it |
| ui/rate-limits-sync.spec.ts | 7 | 25 | 10 | 0/0/1 |  | keep | red with a product change in the window |
| ui/archived-lazy-load.spec.ts | 5 | 24 | 3 | 0/0/0 |  | keep | no signal against it |
| ui/browser-pane-park-on-close.spec.ts | 6 | 24 | 2 | 0/0/0 | retained-pane-never-remounts | keep | named as a rule enforcement |
| ui/remember-active-task.spec.ts | 5 | 24 | 3 | 0/0/0 |  | keep | no signal against it |
| ui/task-detail-changes-markdown-links.spec.ts | 8 | 24 | 1 | 0/0/0 |  | keep | no signal against it |
| ui/task-detail-changes-popout-close.spec.ts | 3 | 24 | 3 | 0/0/0 |  | trimmed | 1 removed |
| ui/workflow-agent-prompt-setting.spec.ts | 4 | 24 | 3 | 0/0/0 |  | keep | no signal against it |
| ui/agent-tab-force-refresh.spec.ts | 4 | 23 | 7 | 0/0/0 |  | trimmed | 1 removed |
| ui/agent-tab-wsl-status.spec.ts | 4 | 23 | 3 | 0/0/0 |  | keep | no signal against it |
| ui/announcements.spec.ts | 18 | 23 | 6 | 0/0/0 |  | keep | no signal against it |
| ui/task-prior-work.spec.ts | 7 | 23 | 4 | 0/0/0 |  | keep | no signal against it |
| ui/workflow-stalled-toast.spec.ts | 5 | 23 | 1 | 0/0/0 |  | keep | no signal against it |
| ui/app.spec.ts | 37 | 22 | 28 | 0/0/0 |  | moved down | 1 test, mock harness |
| ui/description-editor-file-mentions.spec.ts | 20 | 22 | 10 | 0/2/0 |  | keep | no signal against it |
| ui/git-hold-prompt-setting.spec.ts | 5 | 22 | 1 | 0/0/0 |  | keep | no signal against it |
| ui/task-detail-changes-markdown-document.spec.ts | 7 | 22 | 1 | 0/0/0 |  | trimmed | 1 removed |
| ui/terminal-arrival-focus.spec.ts | 4 | 22 | 9 | 0/0/0 | agent-driven-focus terminal-arrival-focus | keep | named as a rule enforcement |
| ui/update-blocked-toast.spec.ts | 4 | 22 | 4 | 0/1/0 |  | trimmed | 1 folded |
| ui/window-light-dismiss-terminal-panel.spec.ts | 4 | 22 | 4 | 0/0/0 | light-dismiss-denylist | keep | named as a rule enforcement |
| ui/board-config-save-refusals.spec.ts | 4 | 21 | 2 | 0/0/0 |  | keep | no signal against it |
| ui/commit-graph-hash-link.spec.ts | 2 | 21 | 1 | 0/0/0 |  | keep | no signal against it |
| ui/template-text-field.spec.ts | 17 | 21 | 2 | 0/0/0 |  | keep | no signal against it |
| ui/auto-command-result-toast.spec.ts | 4 | 20 | 2 | 0/0/0 |  | keep | no signal against it |
| ui/backlog-dialog-ux.spec.ts | 23 | 20 | 9 | 0/0/0 |  | keep | no signal against it |
| ui/mcp-connection-row.spec.ts | 6 | 20 | 3 | 0/0/0 |  | keep | no signal against it |
| ui/move-to-done-no-snapback.spec.ts | 3 | 20 | 3 | 0/0/0 |  | keep | no signal against it |
| ui/theme-swatch-grid.spec.ts | 16 | 20 | 2 | 0/0/0 |  | keep | no signal against it |
| ui/toggle-card.spec.ts | 23 | 20 | 18 | 0/0/1 | settings-card-design | keep | named as a rule enforcement |
| ui/browser-pane-close.spec.ts | 5 | 19 | 4 | 0/0/0 |  | keep | no signal against it |
| ui/changes-blame-gutter.spec.ts | 5 | 19 | 8 | 0/0/0 |  | trimmed | 1 folded |
| ui/command-terminal-branch.spec.ts | 3 | 19 | 3 | 0/0/0 | command-terminal | keep | named as a rule enforcement |
| ui/conversation-expired-toast.spec.ts | 5 | 19 | 4 | 0/0/0 |  | trimmed | 4 removed |
| ui/segmented-control.spec.ts | 10 | 19 | 6 | 0/0/0 |  | keep | no signal against it |
| ui/task-detail-launch-overlay.spec.ts | 3 | 19 | 3 | 0/0/0 |  | keep | no signal against it |
| ui/use-value-pulse-reset-key.spec.ts | 3 | 19 | 3 | 0/0/0 |  | keep | no signal against it |
| ui/workflow-agent-setting-rows.spec.ts | 4 | 19 | 3 | 0/0/0 |  | keep | no signal against it |
| ui/board-config.spec.ts | 4 | 18 | 4 | 0/0/0 |  | trimmed | 1 removed, 1 folded |
| ui/cursor-context-bar.spec.ts | 4 | 18 | 6 | 0/0/0 |  | keep | no signal against it |
| ui/label-promotion.spec.ts | 5 | 18 | 3 | 0/0/0 |  | moved down | 4 tests, mock harness |
| ui/move-to-done-cross-project.spec.ts | 4 | 18 | 4 | 0/0/0 |  | trimmed, moved down | 1 removed, 2 moved |
| ui/pr-url.spec.ts | 4 | 18 | 8 | 0/0/0 |  | keep | no signal against it |
| ui/rate-limits-pill-tick.spec.ts | 3 | 18 | 1 | 0/0/0 |  | keep | no signal against it |
| ui/sidebar-divider.spec.ts | 6 | 18 | 4 | 0/0/0 |  | keep | no signal against it |
| ui/task-card-context-window.spec.ts | 4 | 18 | 6 | 0/0/0 |  | keep | no signal against it |
| ui/task-detail-header-overflow.spec.ts | 4 | 18 | 4 | 0/0/0 |  | keep | no signal against it |
| ui/board-manager-profiles.spec.ts | 10 | 17 | 2 | 0/0/0 |  | trimmed | 1 folded |
| ui/browser-pill-gate.spec.ts | 3 | 17 | 5 | 0/0/0 |  | keep | no signal against it |
| ui/command-terminal-launch-overlay.spec.ts | 3 | 17 | 1 | 0/0/0 | command-terminal | keep | named as a rule enforcement |
| ui/dictation-settings-search.spec.ts | 4 | 17 | 2 | 0/0/0 |  | keep | no signal against it |
| ui/unarchive-task-optimistic.spec.ts | 6 | 17 | 4 | 0/0/0 |  | keep | no signal against it |
| ui/commit-graph-panel.spec.ts | 6 | 16 | 12 | 0/0/0 |  | keep | no signal against it |
| ui/drag-and-drop.spec.ts | 6 | 16 | 10 | 0/0/0 |  | keep | no signal against it |
| ui/launch-overlay-terminal-surface.spec.ts | 5 | 16 | 3 | 0/0/0 |  | keep | no signal against it |
| ui/task-detail-description-peek.spec.ts | 11 | 16 | 11 | 0/0/0 |  | keep | no signal against it |
| ui/view-toggle-no-cross-fade.spec.ts | 3 | 16 | 2 | 0/0/0 |  | keep | no signal against it |
| ui/context-bar-fold.spec.ts | 3 | 15 | 2 | 0/0/0 |  | keep | no signal against it |
| ui/project-open-not-found.spec.ts | 3 | 15 | 5 | 0/0/0 |  | keep | no signal against it |
| ui/spawn-blocked-toast.spec.ts | 4 | 15 | 5 | 0/0/0 |  | keep | no signal against it |
| ui/stats-lazy-retry.spec.ts | 2 | 15 | 2 | 0/0/0 |  | keep | no signal against it |
| ui/task-detail-move-column-hotkeys.spec.ts | 10 | 15 | 5 | 0/0/0 |  | keep | no signal against it |
| ui/task-detail-view-state-persistence.spec.ts | 2 | 15 | 2 | 0/0/0 |  | keep | no signal against it |
| ui/wait-for-settled.spec.ts | 11 | 15 | 2 | 0/0/0 |  | keep | no signal against it |
| ui/changes-panel-file-list.spec.ts | 3 | 14 | 6 | 0/0/0 |  | keep | no signal against it |
| ui/config-write-failed-toast.spec.ts | 3 | 14 | 4 | 0/0/0 |  | trimmed | 1 folded |
| ui/move-to-done-archives.spec.ts | 2 | 14 | 5 | 0/0/0 |  | keep | no signal against it |
| ui/pr-link-resolve-toast.spec.ts | 10 | 14 | 6 | 0/0/0 |  | keep | no signal against it |
| ui/browser-pane-request-bridge.spec.ts | 4 | 13 | 3 | 0/0/0 |  | keep | no signal against it |
| ui/conversation-window-workspace-restore.spec.ts | 3 | 13 | 2 | 0/0/0 |  | keep | no signal against it |
| ui/hotkeys-settings.spec.ts | 10 | 13 | 6 | 0/0/0 |  | keep | no signal against it |
| ui/move-to-done-reload-no-source-flash.spec.ts | 2 | 13 | 4 | 0/0/0 | board-completing-task-chokepoint | keep | named as a rule enforcement |
| ui/plan-complete-toast.spec.ts | 3 | 13 | 3 | 0/0/0 |  | keep | no signal against it |
| ui/terminal-ctrl-c-interrupt.spec.ts | 3 | 13 | 4 | 0/0/0 |  | keep | no signal against it |
| ui/agent-open-pane-focus.spec.ts | 4 | 12 | 2 | 0/0/0 | agent-driven-focus | keep | named as a rule enforcement |
| ui/changes-panel-diffviewer-copy.spec.ts | 6 | 12 | 2 | 0/0/0 |  | keep | no signal against it |
| ui/label-input.spec.ts | 3 | 12 | 4 | 0/0/0 |  | keep | no signal against it |
| ui/project-switch-warm-cache.spec.ts | 2 | 12 | 4 | 0/0/0 |  | keep | no signal against it |
| ui/spawn-warning-toast.spec.ts | 3 | 12 | 4 | 0/0/0 |  | keep | no signal against it |
| ui/terminal-no-flash-on-switch.spec.ts | 4 | 12 | 3 | 0/0/0 |  | keep | no signal against it |
| ui/terminal-osc52-copy.spec.ts | 3 | 12 | 2 | 0/0/0 |  | keep | no signal against it |
| ui/workflow-complete-toast.spec.ts | 3 | 12 | 1 | 0/0/0 |  | keep | no signal against it |
| ui/backlog-mcp-push.spec.ts | 2 | 11 | 1 | 0/0/0 |  | keep | no signal against it |
| ui/browser-pane-registration.spec.ts | 3 | 11 | 4 | 0/0/0 | retained-pane-never-remounts | keep | named as a rule enforcement |
| ui/changes-panel-scope.spec.ts | 3 | 11 | 7 | 0/0/0 |  | keep | no signal against it |
| ui/goto-vite-boot-retry.spec.ts | 2 | 11 | 1 | 0/0/0 |  | keep | no signal against it |
| ui/task-attachments.spec.ts | 17 | 11 | 17 | 0/0/0 |  | keep | no signal against it |
| ui/window-park-reveal.spec.ts | 2 | 11 | 3 | 0/0/0 |  | keep | no signal against it |
| ui/board-manager-agent-gate.spec.ts | 2 | 10 | 5 | 0/0/0 |  | keep | no signal against it |
| ui/completed-task-tabs-scroll.spec.ts | 2 | 10 | 1 | 0/0/0 |  | keep | no signal against it |
| ui/conversation-open-position.spec.ts | 2 | 10 | 2 | 0/0/0 |  | keep | no signal against it |
| ui/conversation-pill-disabled-state.spec.ts | 2 | 10 | 4 | 0/0/0 |  | keep | no signal against it |
| ui/conversation-scrollbar.spec.ts | 2 | 10 | 2 | 0/0/0 |  | keep | no signal against it |
| ui/host-memory-pressure.spec.ts | 3 | 10 | 8 | 0/0/0 |  | keep | no signal against it |
| ui/move-to-done-worktree-rect-fallback.spec.ts | 2 | 10 | 4 | 0/0/0 |  | trimmed | 1 removed |
| ui/settings-panel-agent-gate.spec.ts | 2 | 10 | 5 | 0/0/0 |  | keep | no signal against it |
| ui/task-detail-isolated-badge.spec.ts | 2 | 10 | 3 | 0/0/0 |  | keep | no signal against it |
| ui/terminal-tab-isolated-badge.spec.ts | 3 | 10 | 3 | 0/0/0 |  | keep | no signal against it |
| ui/terminal-webgl-subpixel-font.spec.ts | 2 | 10 | 1 | 0/0/0 |  | keep | no signal against it |
| ui/todo-stale-exited-row-opens-edit.spec.ts | 3 | 10 | 2 | 0/0/0 | session-replica-contract | keep | named as a rule enforcement |
| ui/window-content-deep-archive-self-heal.spec.ts | 2 | 10 | 2 | 0/0/0 |  | keep | no signal against it |
| ui/browser-settings.spec.ts | 10 | 9 | 7 | 0/0/0 |  | keep | no signal against it |
| ui/changes-panel-lazy-retry.spec.ts | 1 | 9 | 4 | 0/0/0 |  | keep | no signal against it |
| ui/context-bar-unknown-window.spec.ts | 2 | 9 | 4 | 0/0/0 |  | keep | no signal against it |
| ui/conversation-auto-follow.spec.ts | 1 | 9 | 2 | 0/0/0 |  | keep | no signal against it |
| ui/task-detail-archived-no-resume.spec.ts | 2 | 9 | 4 | 0/0/0 |  | keep | no signal against it |
| ui/task-detail-update-from-base.spec.ts | 2 | 9 | 4 | 0/0/0 |  | keep | no signal against it |
| ui/window-no-entrance-animation-on-restore.spec.ts | 2 | 9 | 3 | 0/0/0 | restore-no-animation-replay | keep | named as a rule enforcement |
| ui/board-manager-legacy-role.spec.ts | 2 | 8 | 3 | 0/0/0 |  | keep | no signal against it |
| ui/changes-file-popout.spec.ts | 5 | 8 | 6 | 0/0/0 |  | keep | no signal against it |
| ui/changes-history-section.spec.ts | 3 | 8 | 3 | 0/0/0 |  | keep | no signal against it |
| ui/changes-panel-branch-header.spec.ts | 2 | 8 | 8 | 0/0/0 |  | keep | no signal against it |
| ui/changes-panel-collapse-unchanged.spec.ts | 1 | 8 | 6 | 0/0/0 |  | keep | no signal against it |
| ui/changes-panel-keyboard-nav.spec.ts | 2 | 8 | 3 | 0/0/0 |  | keep | no signal against it |
| ui/changes-stale-selection.spec.ts | 2 | 8 | 2 | 0/0/0 |  | keep | no signal against it |
| ui/handoff-suspend-preserves-spawn-label.spec.ts | 2 | 8 | 2 | 0/0/0 |  | keep | no signal against it |
| ui/idle-toast-own-call.spec.ts | 2 | 8 | 1 | 0/0/0 |  | keep | no signal against it |
| ui/reduced-motion-animate-pulse.spec.ts | 2 | 8 | 2 | 0/0/0 |  | keep | no signal against it |
| ui/restore-from-done-shows-progress.spec.ts | 2 | 8 | 2 | 0/0/0 |  | keep | no signal against it |
| ui/task-detail-folder-controls.spec.ts | 1 | 8 | 4 | 0/0/0 |  | keep | no signal against it |
| ui/terminal-dispose-mouse-tracking.spec.ts | 2 | 8 | 2 | 0/0/0 |  | keep | no signal against it |
| ui/terminal-replay-veil.spec.ts | 2 | 8 | 4 | 0/1/0 |  | keep | no signal against it |
| ui/browser-empty-state.spec.ts | 6 | 7 | 5 | 0/0/0 |  | keep | no signal against it |
| ui/idle-timeout-toast.spec.ts | 2 | 7 | 1 | 0/0/0 |  | keep | no signal against it |
| ui/spawn-progress-clear-on-todo-move.spec.ts | 2 | 7 | 2 | 0/0/0 |  | keep | no signal against it |
| ui/status-bar-agent-not-found.spec.ts | 2 | 7 | 2 | 0/0/0 |  | keep | no signal against it |
| ui/task-move-revert-on-spawn-failure.spec.ts | 2 | 7 | 3 | 0/0/0 |  | keep | no signal against it |
| ui/terminal-arrival-focus-hidden.spec.ts | 2 | 7 | 1 | 0/0/0 | terminal-arrival-focus | keep | named as a rule enforcement |
| ui/terminal-panel-hidden-webgl.spec.ts | 2 | 7 | 1 | 0/0/0 |  | keep | no signal against it |
| ui/browser-pane-refetch-guard.spec.ts | 1 | 6 | 2 | 0/0/0 |  | keep | no signal against it |
| ui/bulk-delete-progress.spec.ts | 1 | 6 | 2 | 0/0/0 |  | keep | no signal against it |
| ui/changes-file-history.spec.ts | 1 | 6 | 6 | 0/0/0 |  | keep | no signal against it |
| ui/changes-panel-base-label.spec.ts | 2 | 6 | 3 | 0/0/0 |  | keep | no signal against it |
| ui/changes-panel-remote-refresh.spec.ts | 1 | 6 | 2 | 0/0/0 |  | keep | no signal against it |
| ui/diff-view-mode-preference.spec.ts | 2 | 6 | 6 | 0/0/0 |  | keep | no signal against it |
| ui/move-stale-reload-no-lane-flash.spec.ts | 1 | 6 | 2 | 0/0/0 | board-completing-task-chokepoint | keep | named as a rule enforcement |
| ui/move-to-done-animations.spec.ts | 1 | 6 | 3 | 0/0/0 |  | trimmed | folds into no-snapback |
| ui/move-to-done-confirm-animation.spec.ts | 1 | 6 | 6 | 0/0/0 |  | keep | no signal against it |
| ui/move-to-done-continuous-visibility.spec.ts | 1 | 6 | 3 | 0/0/0 | board-completing-task-chokepoint | keep | named as a rule enforcement |
| ui/popover-viewport-flip.spec.ts | 1 | 6 | 2 | 0/0/0 |  | keep | no signal against it |
| ui/root-boundary-releases-focus.spec.ts | 1 | 6 | 1 | 0/0/0 |  | keep | no signal against it |
| ui/settings-failure-toast-per-setting.spec.ts | 1 | 6 | 3 | 0/0/0 |  | trimmed | folds into settings-write-failure-toast |
| ui/task-changes-dialog-lazy-retry.spec.ts | 1 | 6 | 3 | 0/0/0 |  | keep | no signal against it |
| ui/terminal-webgl-retry.spec.ts | 1 | 6 | 2 | 0/0/0 |  | keep | no signal against it |
| ui/window-hidden-on-backlog.spec.ts | 1 | 6 | 2 | 0/0/0 |  | keep | no signal against it |
| ui/window-reveal-grid-width.spec.ts | 1 | 6 | 4 | 0/0/0 |  | keep | no signal against it |
| ui/attachment-open-failure.spec.ts | 5 | 5 | 3 | 0/0/0 |  | keep | no signal against it |
| ui/auto-name-from-prompt.spec.ts | 6 | 5 | 7 | 0/0/0 |  | keep | no signal against it |
| ui/changes-panel-diff-disposal.spec.ts | 1 | 5 | 4 | 0/0/0 |  | keep | no signal against it |
| ui/changes-panel-fetch-guard.spec.ts | 1 | 5 | 3 | 0/1/0 |  | keep | no signal against it |
| ui/changes-panel-viewed.spec.ts | 1 | 5 | 5 | 0/0/0 |  | keep | no signal against it |
| ui/context-bar-version-pill.spec.ts | 1 | 5 | 2 | 0/0/0 |  | keep | no signal against it |
| ui/import-attachments.spec.ts | 1 | 5 | 2 | 0/0/0 |  | keep | no signal against it |
| ui/move-to-done-worktree-await-no-source-flash.spec.ts | 1 | 5 | 3 | 0/0/0 | board-completing-task-chokepoint | keep | named as a rule enforcement |
| ui/session-fork-toast.spec.ts | 5 | 5 | 5 | 0/0/0 |  | keep | no signal against it |
| ui/settings-panel-scroll.spec.ts | 1 | 5 | 1 | 0/0/0 |  | keep | no signal against it |
| ui/task-detail-suspended-self-heal.spec.ts | 4 | 5 | 5 | 0/0/0 |  | keep | no signal against it |
| ui/board-filter.spec.ts | 14 | 4 | 8 | 0/0/0 |  | trimmed | 1 removed; "title match" stays, nothing else asserts it |
| ui/changes-panel-file-actions.spec.ts | 1 | 4 | 4 | 0/0/0 |  | keep | no signal against it |
| ui/context-bar-stale-session-id.spec.ts | 1 | 4 | 2 | 0/0/0 |  | keep | no signal against it |
| ui/dictation-stop-failure.spec.ts | 1 | 4 | 2 | 0/0/0 |  | keep | no signal against it |
| ui/dictation-worker-unavailable.spec.ts | 6 | 4 | 5 | 0/0/0 |  | trimmed | 1 removed |
| ui/image-compression.spec.ts | 3 | 4 | 4 | 0/0/0 |  | keep | no signal against it |
| ui/kebab-menu-escape-guard.spec.ts | 1 | 4 | 3 | 0/0/0 |  | keep | no signal against it |
| ui/no-motion-tailwind-variant.spec.ts | 3 | 4 | 1 | 0/0/0 |  | keep | no signal against it |
| ui/non-done-drop-settle.spec.ts | 1 | 4 | 3 | 0/0/0 |  | keep | no signal against it |
| ui/pr-link-badge.spec.ts | 9 | 4 | 8 | 0/0/0 |  | keep | no signal against it |
| ui/session-pause-move.spec.ts | 3 | 4 | 4 | 0/0/0 |  | keep | no signal against it |
| ui/session-resume-drops-paused-row.spec.ts | 1 | 4 | 1 | 0/0/0 |  | keep | no signal against it |
| ui/task-detail-changes-panel.spec.ts | 1 | 4 | 5 | 0/0/0 |  | keep | no signal against it |
| ui/terminal-backspace-bytes.spec.ts | 1 | 4 | 1 | 0/0/0 |  | keep | no signal against it |
| ui/terminal-init-timing-trace.spec.ts | 1 | 4 | 2 | 0/0/0 |  | keep | no signal against it |
| ui/terminal-panel-collapsed-focus.spec.ts | 1 | 4 | 3 | 0/0/0 |  | keep | no signal against it |
| ui/toolbar-collapse-remeasure.spec.ts | 1 | 4 | 1 | 0/0/0 |  | keep | no signal against it |
| ui/attachment-add-failure.spec.ts | 2 | 3 | 2 | 0/0/0 |  | keep | no signal against it |
| ui/board-drag-skips-card-content.spec.ts | 2 | 3 | 1 | 0/0/0 |  | keep | no signal against it |
| ui/developer-tab-defaults.spec.ts | 3 | 3 | 2 | 0/0/0 |  | keep | no signal against it |
| ui/overlay-exit-fallback.spec.ts | 3 | 3 | 1 | 0/0/0 |  | keep | no signal against it |
| ui/popout-window-frame-escape.spec.ts | 7 | 3 | 2 | 0/0/0 |  | keep | no signal against it |
| ui/project-move.spec.ts | 7 | 3 | 4 | 0/0/0 |  | keep | no signal against it |
| ui/session-resume-self-heal-toast.spec.ts | 2 | 3 | 3 | 0/0/0 |  | keep | no signal against it |
| ui/task-detail-attachments.spec.ts | 2 | 3 | 2 | 0/0/0 |  | keep | no signal against it |
| ui/terminal-query-replies.spec.ts | 1 | 3 | 1 | 0/0/0 | xterm-query-replies | keep | named as a rule enforcement |
| ui/todo-reset-no-ghost-session.spec.ts | 1 | 3 | 3 | 0/0/0 | session-replica-contract | keep | named as a rule enforcement |
| ui/unarchive-to-todo-no-paused-row.spec.ts | 1 | 3 | 2 | 0/0/0 |  | keep | no signal against it |
| ui/drag-prefetch-remotes.spec.ts | 2 | 2 | 2 | 0/0/0 |  | keep | no signal against it |
| ui/project-settings-seed-isolation.spec.ts | 2 | 2 | 3 | 0/0/0 |  | moved down | both tests, file removed |
| ui/task-create-hotkey.spec.ts | 3 | 2 | 4 | 0/0/0 |  | keep | no signal against it |
| ui/collect-page-errors.spec.ts | 3 | 1 | 1 | 0/0/0 |  | keep | no signal against it |
| ui/diff-viewer-theme-preview.spec.ts | 2 | 1 | 2 | 0/0/0 |  | keep | no signal against it |
| ui/drag-coalesce.spec.ts | 1 | 1 | 3 | 0/0/0 |  | keep | no signal against it |
| ui/task-card-agent-trail.spec.ts | 9 | 1 | 4 | 0/0/0 |  | keep | no signal against it |
| ui/task-changes-dialog.spec.ts | 1 | 1 | 2 | 0/0/0 |  | keep | no signal against it |
| ui/task-detail-prespawn-layout.spec.ts | 1 | 1 | 2 | 0/0/0 |  | keep | no signal against it |
| ui/window-auto-close-on-done.spec.ts | 1 | 1 | 2 | 0/0/0 |  | keep | no signal against it |
| ui/browser-download-toast.spec.ts | 3 | 0 | 4 | 0/0/0 |  | keep | no signal against it |
| ui/idle-hint-activity-log.spec.ts | 4 | 0 | 4 | 0/0/0 |  | keep | no signal against it |
| ui/image-compress-calibration.spec.ts | 0 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| ui/kimi-subagent-activity-log.spec.ts | 4 | 0 | 4 | 0/0/0 |  | keep | no signal against it |
| ui/layout-change-hold-then-draw.spec.ts | 5 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| ui/session-exit-intentional.spec.ts | 1 | 0 | 4 | 0/0/0 |  | keep | no signal against it |
| ui/task-card-display-id.spec.ts | 3 | 0 | 5 | 0/0/0 |  | keep | no signal against it |
| ui/turn-retrying-activity-log.spec.ts | 4 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/session-manager.test.ts | 180 | 66 | 68 | 0/0/0 |  | keep | no signal against it |
| unit/terminal-submit.test.ts | 40 | 61 | 9 | 0/0/0 |  | keep | no signal against it |
| unit/spare-worktree-claim.test.ts | 22 | 47 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/spare-worktree-pool-lifecycle.test.ts | 17 | 21 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/event-activity-derivation-2.test.ts | 21 | 20 | 4 | 0/0/0 |  | keep | no signal against it |
| unit/session-manager-data-tap.test.ts | 12 | 20 | 12 | 0/0/0 |  | keep | no signal against it |
| unit/event-loop-watchdog.test.ts | 20 | 14 | 8 | 0/0/0 | pty-host-out-of-process retrieval-out-of-process | keep | named as a rule enforcement |
| unit/late-confirmation-integration.test.ts | 1 | 14 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/session-reap-real-processes.test.ts | 19 | 11 | 9 | 0/0/0 | task-process-tag | keep | named as a rule enforcement |
| unit/event-activity-derivation.test.ts | 22 | 10 | 37 | 0/0/0 |  | keep | no signal against it |
| unit/session-suspend.test.ts | 8 | 9 | 12 | 0/0/0 |  | keep | no signal against it |
| unit/injection-load-rig.test.ts | 7 | 8 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/worktree-preview-stop.test.ts | 26 | 8 | 3 | 0/0/0 | task-process-tag | keep | named as a rule enforcement |
| unit/claude-model-picker-probe.test.ts | 134 | 7 | 10 | 0/0/0 | pty-teardown-grace xterm-unicode11-parity | keep | named as a rule enforcement |
| unit/workflow-agent-access.test.ts | 34 | 7 | 7 | 0/0/0 |  | keep | no signal against it |
| unit/workflow-service.test.ts | 62 | 7 | 13 | 0/0/0 |  | keep | no signal against it |
| unit/pty-host-core-tagged-reap.test.ts | 12 | 6 | 7 | 0/0/0 | task-process-tag | keep | named as a rule enforcement |
| unit/background-command-reporting.test.ts | 92 | 5 | 4 | 0/0/0 |  | keep | no signal against it |
| unit/qwen-session-history-parser.test.ts | 14 | 5 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/demo-frame-format.test.ts | 48 | 4 | 1 | 0/0/0 | web-demo-parity | keep | named as a rule enforcement |
| unit/prune-orphaned-dirs.test.ts | 16 | 4 | 22 | 0/0/0 |  | keep | no signal against it |
| unit/terminal-layout-transition.test.ts | 17 | 4 | 6 | 0/0/0 | command-terminal | keep | named as a rule enforcement |
| unit/trust-manager.test.ts | 35 | 4 | 7 | 0/0/0 |  | keep | no signal against it |
| unit/turn-end-runner-visit-guards.test.ts | 62 | 4 | 18 | 0/0/0 |  | keep | no signal against it |
| unit/workflow-agent-spend.test.ts | 37 | 4 | 10 | 0/0/0 |  | keep | no signal against it |
| unit/browser-viewport-override.test.ts | 65 | 3 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/build-review-pack.test.ts | 28 | 3 | 12 | 0/0/0 |  | keep | no signal against it |
| unit/conversation-indexer-resume.test.ts | 15 | 3 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/retrieval-out-of-process-boundary.test.ts | 5 | 3 | 4 | 0/0/0 | retrieval-out-of-process | keep | named as a rule enforcement |
| unit/run-stop-script.test.ts | 11 | 3 | 2 | 0/0/0 | task-process-tag | keep | named as a rule enforcement |
| unit/shell-launch-contract.test.ts | 4 | 3 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/task-changes-real-git.test.ts | 28 | 3 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/workflow-agent-start-over.test.ts | 68 | 3 | 12 | 0/0/0 |  | keep | no signal against it |
| unit/workflow-engine-host-start-backoff.test.ts | 33 | 3 | 7 | 0/0/0 |  | keep | no signal against it |
| unit/activity-engine-turn-ended.test.ts | 40 | 2 | 8 | 0/0/0 |  | keep | no signal against it |
| unit/automation-commands.test.ts | 52 | 2 | 9 | 0/0/0 |  | keep | no signal against it |
| unit/automation-repository.test.ts | 52 | 2 | 8 | 0/0/0 |  | keep | no signal against it |
| unit/automation-run-frequency-boundary.test.ts | 26 | 2 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/board-config-automations-roundtrip.test.ts | 55 | 2 | 9 | 0/0/0 |  | keep | no signal against it |
| unit/demo-fixtures-sanitized.test.ts | 74 | 2 | 8 | 0/0/0 | web-demo-parity | keep | named as a rule enforcement |
| unit/diff-service-range-real-git.test.ts | 12 | 2 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/droid-adapter.test.ts | 64 | 2 | 8 | 0/0/0 |  | keep | no signal against it |
| unit/event-bridge-remap.test.ts | 57 | 2 | 15 | 0/0/0 |  | keep | no signal against it |
| unit/event-bridge.test.ts | 78 | 2 | 18 | 0/0/0 | cross-platform-parity | keep | named as a rule enforcement |
| unit/gemini-session-history-parser.test.ts | 15 | 2 | 5 | 0/0/0 |  | keep | no signal against it |
| unit/grok-adapter.test.ts | 128 | 2 | 13 | 0/0/0 |  | keep | no signal against it |
| unit/i18n-boundaries.test.ts | 14 | 2 | 5 | 0/0/0 | i18n | keep | named as a rule enforcement |
| unit/mcp-move-task-workflow-lock.test.ts | 39 | 2 | 4 | 0/0/0 |  | keep | no signal against it |
| unit/mcp-running-work-guard.test.ts | 58 | 2 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/message-trail-tracker.test.ts | 28 | 2 | 7 | 0/0/0 | session-replica-contract | keep | named as a rule enforcement |
| unit/mobile-bridge/bridge-session-rekey-loss.test.ts | 23 | 2 | 4 | 0/0/0 |  | keep | no signal against it |
| unit/opencode-schema-canary.test.ts | 9 | 2 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/pty-buffer-manager.test.ts | 154 | 2 | 32 | 0/0/0 |  | keep | no signal against it |
| unit/pty-host-core.test.ts | 117 | 2 | 15 | 0/0/0 | pty-host-out-of-process pty-teardown-grace | keep | named as a rule enforcement |
| unit/retrieval-service-status-gates.test.ts | 42 | 2 | 4 | 0/0/0 |  | keep | no signal against it |
| unit/retrieval-service-summary-every-project.test.ts | 22 | 2 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/review-ledger-commitlint.test.ts | 4 | 2 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/task-repository-automations-disabled.test.ts | 34 | 2 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/task-running-work.test.ts | 22 | 2 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/workflow-engine-boot-probe.test.ts | 27 | 2 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/workflow-recovery.test.ts | 85 | 2 | 8 | 0/0/0 |  | keep | no signal against it |
| unit/workflow-run-settings.test.ts | 17 | 2 | 4 | 0/0/0 |  | keep | no signal against it |
| unit/workflow-view-service.test.ts | 41 | 2 | 10 | 0/0/0 |  | keep | no signal against it |
| unit/worktree-base-branch.test.ts | 29 | 2 | 11 | 0/0/0 |  | keep | no signal against it |
| unit/antigravity-print-runner.test.ts | 7 | 1 | 5 | 0/0/0 |  | keep | no signal against it |
| unit/background-calls.test.ts | 36 | 1 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/background-shell-hint-bridge.test.ts | 21 | 1 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/bash-guard.test.ts | 20 | 1 | 2 | 0/0/0 | bash-single-command | keep | named as a rule enforcement |
| unit/claude-slash-command-verifier.test.ts | 31 | 1 | 7 | 0/0/0 |  | keep | no signal against it |
| unit/codex-adapter.test.ts | 99 | 1 | 29 | 0/0/0 | task-process-tag | keep | named as a rule enforcement |
| unit/column-commands-create-delete.test.ts | 45 | 1 | 6 | 0/0/0 | mcp-column-field-parity | keep | named as a rule enforcement |
| unit/command-terminal-conversation-index.test.ts | 18 | 1 | 1 | 0/0/0 | command-terminal | keep | named as a rule enforcement |
| unit/command-terminal-history.test.ts | 35 | 1 | 7 | 0/0/0 | command-terminal | keep | named as a rule enforcement |
| unit/commit-corpus.test.ts | 23 | 1 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/config-manager.test.ts | 124 | 1 | 37 | 0/0/0 |  | keep | no signal against it |
| unit/conversation-indexer-reported-path.test.ts | 10 | 1 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/conversation-indexer-workflow-agent.test.ts | 8 | 1 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/conversation-usage-fanout-sql.test.ts | 16 | 1 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/conversation-usage-store.test.ts | 24 | 1 | 8 | 0/0/0 |  | keep | no signal against it |
| unit/count-lines.test.ts | 6 | 1 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/cursor-adapter.test.ts | 102 | 1 | 9 | 0/0/0 |  | keep | no signal against it |
| unit/demo-frame-fit.test.ts | 71 | 1 | 2 | 0/0/0 | web-demo-parity | keep | named as a rule enforcement |
| unit/demo-message-trail-seeded.test.ts | 9 | 1 | 4 | 0/0/0 | web-demo-parity | keep | named as a rule enforcement |
| unit/dictation-out-of-process-boundary.test.ts | 5 | 1 | 1 | 0/0/0 | dictation-out-of-process | keep | named as a rule enforcement |
| unit/done-worktree-move-aside.test.ts | 11 | 1 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/earlier-run-result-tokens.test.ts | 25 | 1 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/embed-engine.test.ts | 31 | 1 | 8 | 0/0/0 | central-embedding-engine | keep | named as a rule enforcement |
| unit/eslint-react-hooks-preset.test.ts | 2 | 1 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/eval-harness-on-demand-only.test.ts | 31 | 1 | 7 | 0/0/0 |  | keep | no signal against it |
| unit/final-line-migration.test.ts | 10 | 1 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/focus-union-parity.test.ts | 5 | 1 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/gemini-adapter.test.ts | 39 | 1 | 8 | 0/0/0 |  | keep | no signal against it |
| unit/gemini-session-file-format.test.ts | 8 | 1 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/git-object-reader.test.ts | 13 | 1 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/gpu-health.test.ts | 93 | 1 | 8 | 0/0/0 |  | keep | no signal against it |
| unit/held-messages.test.ts | 56 | 1 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/i18n-translation-catalogs.test.ts | 25 | 1 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/knowledge-graph-projection-engine.test.ts | 38 | 1 | 4 | 0/0/0 |  | keep | no signal against it |
| unit/mcp-move-task-to-project.test.ts | 10 | 1 | 5 | 0/0/0 |  | keep | no signal against it |
| unit/mcp-project-context.test.ts | 69 | 1 | 24 | 0/0/0 | pop-out-surface-registry task-process-tag | keep | named as a rule enforcement |
| unit/mcp-task-session-tools.test.ts | 79 | 1 | 17 | 0/0/0 |  | keep | no signal against it |
| unit/mobile-bridge/bridge-session.test.ts | 62 | 1 | 18 | 0/0/0 |  | keep | no signal against it |
| unit/mobile-bridge/read-stream.test.ts | 106 | 1 | 34 | 0/0/0 |  | keep | no signal against it |
| unit/mobile-bridge/relay-client.test.ts | 42 | 1 | 10 | 0/0/0 |  | keep | no signal against it |
| unit/mobile-bridge/request-spans.test.ts | 12 | 1 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/plan-approval-bridge.test.ts | 42 | 1 | 4 | 0/0/0 |  | keep | no signal against it |
| unit/plan-approval-column-commands.test.ts | 17 | 1 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/plan-approval-legacy-adoption.test.ts | 17 | 1 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/plan-approval-read-decision.test.ts | 24 | 1 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/plan-approval-repository-narrowing.test.ts | 13 | 1 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/plan-approval-save-workflow.test.ts | 25 | 1 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/plan-approval-workflow-service.test.ts | 9 | 1 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/pr-connector-gate.test.ts | 44 | 1 | 7 | 0/0/0 | agent-adapters-boundary | keep | named as a rule enforcement |
| unit/preview-git-isolation.test.ts | 14 | 1 | 4 | 0/0/0 |  | keep | no signal against it |
| unit/preview-isolation.test.ts | 27 | 1 | 5 | 0/0/0 | task-process-tag | keep | named as a rule enforcement |
| unit/project-open-lifecycle.test.ts | 67 | 1 | 18 | 0/0/0 |  | keep | no signal against it |
| unit/project-roots.test.ts | 17 | 1 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/project-setup.test.ts | 14 | 1 | 4 | 0/0/0 |  | keep | no signal against it |
| unit/protocol/framing.test.ts | 44 | 1 | 11 | 0/0/0 |  | keep | no signal against it |
| unit/pty-host-boundary.test.ts | 11 | 1 | 4 | 0/0/1 | pty-host-out-of-process | keep | named as a rule enforcement |
| unit/qwen-hook-bridge.test.ts | 18 | 1 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/register-all-command-terminal-history.test.ts | 12 | 1 | 5 | 0/0/0 |  | keep | no signal against it |
| unit/register-all-earlier-runs-source.test.ts | 8 | 1 | 5 | 0/0/0 |  | keep | no signal against it |
| unit/register-all-idempotency.test.ts | 17 | 1 | 33 | 0/1/0 |  | keep | no signal against it |
| unit/register-all-workflow-title.test.ts | 5 | 1 | 5 | 0/0/0 |  | keep | no signal against it |
| unit/release-changelog.test.ts | 45 | 1 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/removed-worktree-restart.test.ts | 2 | 1 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/removed-worktrees-transient.test.ts | 4 | 1 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/repaint-settle-marker.test.ts | 12 | 1 | 5 | 0/0/0 |  | keep | no signal against it |
| unit/retrieval-service-archive-scheduling.test.ts | 19 | 1 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/retrieval-service-command-terminal.test.ts | 10 | 1 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/retrieval-service-finalize-debounce.test.ts | 10 | 1 | 8 | 0/0/0 |  | keep | no signal against it |
| unit/retrieval-service-rebuild.test.ts | 9 | 1 | 3 | 0/1/0 |  | keep | no signal against it |
| unit/retrieval-service-source-totals.test.ts | 16 | 1 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/retrieval-service-summary-backoff.test.ts | 13 | 1 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/retrieval-store-sql.test.ts | 69 | 1 | 10 | 0/0/0 |  | keep | no signal against it |
| unit/retrieval-summary-recording.test.ts | 4 | 1 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/retrieval-worker-closed-project.test.ts | 10 | 1 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/retrieval-worker-graph-progress.test.ts | 4 | 1 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/run-script-adapter.test.ts | 16 | 1 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/scene-registry.test.ts | 29 | 1 | 24 | 0/0/0 | web-demo-parity | keep | named as a rule enforcement |
| unit/sent-session-message-migration.test.ts | 19 | 1 | 4 | 0/0/0 |  | keep | no signal against it |
| unit/session-leftover-reap-wiring.test.ts | 68 | 1 | 20 | 0/0/0 | pop-out-surface-registry task-process-tag | keep | named as a rule enforcement |
| unit/session-manager-agent-ready.test.ts | 13 | 1 | 1 | 0/0/0 | command-terminal | keep | named as a rule enforcement |
| unit/session-manager-hidden-session.test.ts | 36 | 1 | 1 | 0/0/0 | session-replica-contract | keep | named as a rule enforcement |
| unit/session-repository-earlier-runs.test.ts | 12 | 1 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/session-repository-summaries.test.ts | 8 | 1 | 4 | 0/0/0 |  | keep | no signal against it |
| unit/session-store-replica-convergence.test.ts | 9 | 1 | 2 | 0/0/0 | session-replica-contract | keep | named as a rule enforcement |
| unit/spawn-agent-lock-overrides.test.ts | 21 | 1 | 9 | 0/0/1 |  | keep | red with a product change in the window |
| unit/spawn-entry-point-parity.test.ts | 22 | 1 | 13 | 0/0/0 | spawn-entry-point-parity | keep | named as a rule enforcement |
| unit/stop-script-parked.test.ts | 58 | 1 | 2 | 0/0/0 | task-process-tag | keep | named as a rule enforcement |
| unit/stop-script-terminal.test.ts | 10 | 1 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/task-commands-automations-disabled.test.ts | 37 | 1 | 4 | 0/0/0 |  | keep | no signal against it |
| unit/task-knowledge-store.test.ts | 32 | 1 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/task-ordering-sql.test.ts | 15 | 1 | 4 | 0/0/0 |  | keep | no signal against it |
| unit/task-process-readers.test.ts | 51 | 1 | 9 | 0/0/0 | task-process-tag | keep | named as a rule enforcement |
| unit/task-repository-workflow-release.test.ts | 18 | 1 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/task-repository-worktree-skip-reason.test.ts | 17 | 1 | 6 | 0/0/0 |  | keep | no signal against it |
| unit/tasks-automations-disabled-migration.test.ts | 14 | 1 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/tasks-run-mode-migration.test.ts | 8 | 1 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/test-fs-writes-sandboxed.test.ts | 1 | 1 | 1 | 0/0/0 | cross-platform-parity | keep | named as a rule enforcement |
| unit/tool-breakdown-repair.test.ts | 34 | 1 | 4 | 0/0/0 |  | keep | no signal against it |
| unit/transcript-archive.test.ts | 14 | 1 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/transcript-history.test.ts | 18 | 1 | 4 | 0/0/0 |  | keep | no signal against it |
| unit/transcript-methods-saved-conversation.test.ts | 11 | 1 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/transcript-readers-reported-path.test.ts | 21 | 1 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/transcript-repository.test.ts | 8 | 1 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/transcript-service-saved-conversation.test.ts | 16 | 1 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/transition-engine-automations-disabled.test.ts | 31 | 1 | 5 | 0/0/0 |  | keep | no signal against it |
| unit/turn-end-runner-abandoned-turn.test.ts | 30 | 1 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/turn-end-runner-recap-turn.test.ts | 18 | 1 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/turn-end-runner-workflow-step.test.ts | 10 | 1 | 6 | 0/0/0 |  | keep | no signal against it |
| unit/usage-history-aggregates.test.ts | 28 | 1 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/usage-stats-sql-equivalence.test.ts | 6 | 1 | 5 | 0/0/0 |  | keep | no signal against it |
| unit/vite-config-sentry-guards.test.ts | 9 | 1 | 2 | 0/0/0 | release-gates-fail-loudly | keep | named as a rule enforcement |
| unit/workflow-engine-host-gone-links.test.ts | 11 | 1 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/workflow-gone-project-reads.test.ts | 22 | 1 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/workflow-home.test.ts | 12 | 1 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/workflow-memory-resume.test.ts | 20 | 1 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/workflow-plan-approval-running.test.ts | 19 | 1 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/workflow-project-delete.test.ts | 8 | 1 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/workflow-prompt-facts.test.ts | 8 | 1 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/workflow-repositories.test.ts | 36 | 1 | 5 | 0/0/0 |  | keep | no signal against it |
| unit/workflow-step-applies.test.ts | 6 | 1 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/workflow-store-stale-answers.test.ts | 34 | 1 | 4 | 0/0/0 |  | keep | no signal against it |
| unit/worktree-claude-dirs.test.ts | 7 | 1 | 14 | 0/0/0 |  | keep | no signal against it |
| unit/worktree-folder-migration.test.ts | 13 | 1 | 5 | 0/0/0 |  | keep | no signal against it |
| unit/worktree-setup-outside-queue.test.ts | 3 | 1 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/write-worktree-base-branch.test.ts | 3 | 1 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/wsl-hook-transport.test.ts | 33 | 1 | 4 | 0/0/0 |  | keep | no signal against it |
| unit/wsl-session-history.test.ts | 7 | 1 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/abandoned-turns.test.ts | 12 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/activity-debug-overlay-helpers.test.ts | 114 | 0 | 11 | 0/0/0 |  | keep | no signal against it |
| unit/activity-engine-background-commands.test.ts | 6 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/activity-engine-internal-agent-tools.test.ts | 26 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/activity-engine-property.test.ts | 11 | 0 | 5 | 0/0/0 |  | keep | no signal against it |
| unit/activity-engine-reason-reporting.test.ts | 2 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/activity-engine-replay.test.ts | 85 | 0 | 26 | 0/0/0 |  | keep | no signal against it |
| unit/activity-engine-trace-replay.test.ts | 29 | 0 | 10 | 0/0/0 |  | trimmed | one describe.skip whose fixture is gone |
| unit/activity-engine-wait-kind.test.ts | 26 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/activity-engine.test.ts | 244 | 0 | 41 | 0/0/0 |  | keep | no signal against it |
| unit/activity-interval-commands.test.ts | 5 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/activity-interval-migration.test.ts | 6 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/activity-interval-recorder.test.ts | 18 | 0 | 2 | 0/0/0 | session-replica-contract | keep | named as a rule enforcement |
| unit/activity-interval-store.test.ts | 5 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/activity-interval-sweep.test.ts | 5 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/activity-log-renderers.test.ts | 8 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/activity-mark-render.test.ts | 6 | 0 | 4 | 0/0/0 | activity-marks | keep | named as a rule enforcement |
| unit/activity-mark.test.ts | 19 | 0 | 6 | 0/0/0 | activity-marks | keep | named as a rule enforcement |
| unit/activity-reason-tooltip.test.ts | 9 | 0 | 6 | 0/0/0 |  | keep | no signal against it |
| unit/activity-snapshot-writer.test.ts | 14 | 0 | 5 | 0/0/0 |  | keep | no signal against it |
| unit/activity-state-classification.test.ts | 1 | 0 | 2 | 0/0/0 | activity-state-classification | keep | named as a rule enforcement |
| unit/activity-state.test.ts | 13 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/activity-stats-snapshot-parity.test.ts | 3 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/adapter-lifecycle.test.ts | 8 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/adapter-multiline-prompt.test.ts | 11 | 0 | 9 | 0/0/0 |  | keep | no signal against it |
| unit/adjacent-swimlane.test.ts | 10 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/afterpack-fuse-flip-retry.test.ts | 7 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/afterpack-unpacked-worker-verification.test.ts | 23 | 0 | 10 | 0/0/0 |  | keep | no signal against it |
| unit/aftersign-spawn-helper-verification.test.ts | 3 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/agent-cli-not-found.test.ts | 10 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/agent-detector-dead-shim.test.ts | 22 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/agent-detector-fallback.test.ts | 35 | 0 | 6 | 0/0/0 |  | keep | no signal against it |
| unit/agent-detector-invalidate-race.test.ts | 2 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/agent-detector-per-override-cache.test.ts | 5 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/agent-detector-wsl.test.ts | 18 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/agent-drive-store.test.ts | 9 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/agent-driven-focus-sites.test.ts | 6 | 0 | 5 | 0/0/0 | agent-driven-focus | keep | named as a rule enforcement |
| unit/agent-driven-invalidation-changed-in-other-window.test.ts | 7 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/agent-input-burst.test.ts | 6 | 0 | 1 | 0/0/0 | agent-driven-focus | keep | named as a rule enforcement |
| unit/agent-input-focus-guard.test.ts | 16 | 0 | 2 | 0/0/0 | agent-driven-focus | keep | named as a rule enforcement |
| unit/agent-launch-options.test.ts | 6 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/agent-list-capability-fields.test.ts | 3 | 0 | 5 | 0/0/0 |  | keep | no signal against it |
| unit/agent-list-handler.test.ts | 34 | 0 | 12 | 0/0/0 |  | keep | no signal against it |
| unit/agent-login-command.test.ts | 15 | 0 | 5 | 0/0/0 |  | keep | no signal against it |
| unit/agent-message-delivery.test.ts | 18 | 0 | 4 | 0/0/0 |  | keep | no signal against it |
| unit/agent-model-tables.test.ts | 5 | 0 | 1 | 0/0/0 | cli-features-over-custom-layers | keep | named as a rule enforcement |
| unit/agent-output-tracker.test.ts | 21 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/agent-pty-detection.test.ts | 38 | 0 | 11 | 0/0/0 |  | keep | no signal against it |
| unit/agent-reply-and-move-target.test.ts | 12 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/agent-resolver.test.ts | 10 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/agent-settings-reads.test.ts | 23 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/agent-spawn-expired-withhold.test.ts | 73 | 0 | 6 | 0/0/0 |  | keep | no signal against it |
| unit/agent-spawn-handoff-automations-disabled.test.ts | 5 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/agent-submission-verifier-shape.test.ts | 78 | 0 | 10 | 0/0/0 |  | keep | no signal against it |
| unit/agent-summarize-handler.test.ts | 19 | 0 | 8 | 0/0/0 |  | keep | no signal against it |
| unit/agent-summarize-shape.test.ts | 26 | 0 | 6 | 0/0/0 |  | keep | no signal against it |
| unit/agent-wait.test.ts | 11 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/aider-adapter.test.ts | 57 | 0 | 14 | 0/0/0 |  | keep | no signal against it |
| unit/aider-session-history-parser.test.ts | 20 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/aider-transcript-cleanup.test.ts | 15 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/aider-wsl.test.ts | 4 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/allow-scripts-coverage.test.ts | 6 | 0 | 5 | 0/0/0 | dependency-block-parity | keep | named as a rule enforcement |
| unit/analytics-commands-subagent-stats.test.ts | 7 | 0 | 4 | 0/0/0 |  | keep | no signal against it |
| unit/analytics-heartbeat-and-shared-props.test.ts | 9 | 0 | 4 | 0/0/0 |  | keep | no signal against it |
| unit/analytics-run-uptime.test.ts | 27 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/analytics-session-history.test.ts | 4 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/analytics-usage.test.ts | 14 | 0 | 4 | 0/0/0 |  | keep | no signal against it |
| unit/announcements-archive.test.ts | 33 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/announcements-feed.test.ts | 21 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/announcements-init-guard.test.ts | 11 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/announcements-json-valid.test.ts | 4 | 0 | 4 | 0/0/0 |  | keep | no signal against it |
| unit/announcements-store.test.ts | 3 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/ansi-strip.test.ts | 2 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/answer-agent-resolution.test.ts | 16 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/answer-focus.test.ts | 3 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/answer-from-context-parity.test.ts | 6 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/answer-run-delivery.test.ts | 33 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/answer-run-directory.test.ts | 8 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/answer-search-trace.test.ts | 3 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/answer-session-pool.test.ts | 14 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/answer-session-stdin-json.test.ts | 14 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/answer-stream.test.ts | 26 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/antigravity-adapter.test.ts | 95 | 0 | 9 | 0/0/0 |  | keep | no signal against it |
| unit/antigravity-answer-stream.test.ts | 15 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/antigravity-hooks-and-trust.test.ts | 52 | 0 | 5 | 0/0/0 |  | keep | no signal against it |
| unit/antigravity-wsl.test.ts | 5 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/app-layout-render-scope.test.ts | 3 | 0 | 1 | 0/0/0 |  | keep | kept as a pin: a re-render claim needs a client renderer |
| unit/app-relaunch.test.ts | 16 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/apply-config-column-delete.test.ts | 2 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/apply-runtime-config.test.ts | 6 | 0 | 4 | 0/0/0 |  | keep | no signal against it |
| unit/aptabase-response-guard.test.ts | 31 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/archive-methods.test.ts | 10 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/archived-run-metrics.test.ts | 7 | 0 | 1 | 0/0/0 | web-demo-parity | keep | named as a rule enforcement |
| unit/archived-tasks-slice.test.ts | 19 | 0 | 4 | 0/0/0 |  | keep | no signal against it |
| unit/asana-attachments.test.ts | 22 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/asana-credential-store.test.ts | 12 | 0 | 4 | 0/0/0 |  | keep | no signal against it |
| unit/asana-mapper.test.ts | 14 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/asana-url-parser.test.ts | 12 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/aspire-host-death.test.ts | 2 | 0 | 5 | 0/0/0 | task-process-tag | keep | named as a rule enforcement |
| unit/assert-vendor-chunks-lazy.test.ts | 20 | 0 | 6 | 0/0/0 |  | keep | no signal against it |
| unit/attachment-chips.test.ts | 11 | 0 | 4 | 0/0/0 |  | keep | no signal against it |
| unit/attachment-filename.test.ts | 10 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/attachment-open-helper.test.ts | 14 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/attachment-open-with-toast.test.ts | 4 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/auto-branch-name.test.ts | 11 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/auto-command-escalation-gate.test.ts | 5 | 0 | 4 | 0/0/0 |  | keep | no signal against it |
| unit/auto-command-escalation.test.ts | 9 | 0 | 5 | 0/0/0 |  | keep | no signal against it |
| unit/auto-command-outcome.test.ts | 15 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/auto-focus.test.ts | 24 | 0 | 7 | 0/0/0 |  | keep | no signal against it |
| unit/auto-name-clean.test.ts | 31 | 0 | 3 | 0/0/0 | cross-platform-parity | keep | named as a rule enforcement |
| unit/auto-name-scheduler.test.ts | 43 | 0 | 7 | 0/0/0 |  | keep | no signal against it |
| unit/auto-spawn-early-agent.test.ts | 13 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/auto-spawn-first-spawn-lock-wiring.test.ts | 16 | 0 | 8 | 0/0/0 |  | keep | no signal against it |
| unit/auto-spawn-for-task-explicit-start-forward.test.ts | 2 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/auto-spawn-for-task-guards.test.ts | 33 | 0 | 14 | 0/0/0 | task-lifecycle-lock | keep | named as a rule enforcement |
| unit/auto-spawn-move-race.test.ts | 11 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/auto-spawn-only-task-ids.test.ts | 29 | 0 | 6 | 0/0/0 |  | keep | no signal against it |
| unit/auto-spawn-profile-scoped.test.ts | 7 | 0 | 6 | 0/0/0 |  | keep | no signal against it |
| unit/auto-spawn-reconcile.test.ts | 33 | 0 | 4 | 0/0/0 |  | keep | no signal against it |
| unit/automated-keys-guard.test.ts | 7 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/automation-adapter-parity.test.ts | 23 | 0 | 4 | 0/0/0 | automation-adapters | keep | named as a rule enforcement |
| unit/automation-agent.test.ts | 7 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/automation-condition-check.test.ts | 50 | 0 | 10 | 0/0/0 |  | keep | no signal against it |
| unit/automation-describe.test.ts | 23 | 0 | 5 | 0/0/0 |  | keep | no signal against it |
| unit/automation-drafts.test.ts | 77 | 0 | 8 | 0/0/0 |  | keep | no signal against it |
| unit/automation-manifest-reserved-keys.test.ts | 8 | 0 | 4 | 0/0/0 | automation-adapters | keep | named as a rule enforcement |
| unit/automation-needs-agent.test.ts | 18 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/automation-run-again-move.test.ts | 5 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/automation-run-again-paste.test.ts | 2 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/automation-run-again-reply.test.ts | 8 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/automation-run-enter-since.test.ts | 6 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/automation-run-outcome.test.ts | 7 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/automation-runner-guards.test.ts | 22 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/automation-runner.test.ts | 29 | 0 | 6 | 0/0/0 |  | keep | no signal against it |
| unit/automation-template-vars.test.ts | 22 | 0 | 4 | 0/0/0 |  | keep | no signal against it |
| unit/automation-trigger-text.test.ts | 11 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/automations-migration.test.ts | 25 | 0 | 4 | 0/0/0 |  | keep | no signal against it |
| unit/azure-devops-comments-attachments.test.ts | 24 | 0 | 5 | 0/0/0 |  | keep | no signal against it |
| unit/azure-devops-download-auth.test.ts | 19 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/azure-devops-fetch-work-item-ids.test.ts | 4 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/azure-devops-html-converter.test.ts | 25 | 0 | 6 | 0/0/0 |  | keep | no signal against it |
| unit/azure-devops-hydrate-import.test.ts | 3 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/azure-devops-list-external-ids.test.ts | 4 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/azure-devops-pr-detector.test.ts | 26 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/azure-devops-pr-resolver.test.ts | 99 | 0 | 4 | 0/0/0 |  | keep | no signal against it |
| unit/azure-devops-remote-parser.test.ts | 24 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/azure-devops-url-parser.test.ts | 17 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/azure-devops-wiql.test.ts | 25 | 0 | 4 | 0/0/0 |  | keep | no signal against it |
| unit/background-call-match-parity.test.ts | 7 | 0 | 4 | 0/0/0 |  | keep | no signal against it |
| unit/background-call-migration.test.ts | 4 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/background-commands-declaration.test.ts | 22 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/background-display.test.ts | 8 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/background-shell-hint-entries.test.ts | 26 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/background-shell-tools.test.ts | 7 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/backlog-demote-project-scoped.test.ts | 18 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/backlog-import-execute-hydrate.test.ts | 4 | 0 | 4 | 0/0/0 |  | keep | no signal against it |
| unit/backlog-import-promote-dedup.test.ts | 6 | 0 | 5 | 0/0/0 |  | keep | no signal against it |
| unit/backlog-promote-abort.test.ts | 15 | 0 | 14 | 0/0/0 |  | keep | no signal against it |
| unit/backlog-store-demote-task.test.ts | 7 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/backlog-update-delete-handlers.test.ts | 21 | 0 | 6 | 0/0/0 |  | keep | no signal against it |
| unit/backpressure-controller.test.ts | 24 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/baked-release-notes.test.ts | 1 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/before-quit-drain-wiring.test.ts | 23 | 0 | 8 | 0/0/0 | synchronous-shutdown | keep | named as a rule enforcement |
| unit/benign-renderer-errors.test.ts | 15 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/benign-stream-error.test.ts | 6 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/better-sqlite3-loads-in-vitest.test.ts | 6 | 0 | 2 | 0/0/0 | mcp-column-field-parity | keep | named as a rule enforcement |
| unit/bg-shell-watcher.test.ts | 106 | 0 | 20 | 0/0/0 |  | keep | no signal against it |
| unit/blame-reader.test.ts | 8 | 0 | 4 | 0/0/0 |  | keep | no signal against it |
| unit/board-completing-task-chokepoint.test.ts | 3 | 0 | 2 | 0/0/0 | board-completing-task-chokepoint | keep | named as a rule enforcement |
| unit/board-config-atomic-write.test.ts | 12 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/board-config-cache.test.ts | 10 | 0 | 3 | 0/0/1 |  | keep | red with a product change in the window |
| unit/board-config-last-warnings-handler.test.ts | 2 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/board-config-malformed-columns.test.ts | 18 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/board-config-malformed-lists.test.ts | 20 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/board-config-manager-profiles.test.ts | 8 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/board-config-merge-guards.test.ts | 13 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/board-config-on-applied.test.ts | 6 | 0 | 1 | 0/0/0 |  | rewritten | pins one importable file's text |
| unit/board-config-onfilechange.test.ts | 4 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/board-config-parity.test.ts | 23 | 0 | 11 | 0/0/0 | board-config-parity | keep | named as a rule enforcement |
| unit/board-config-set-stop-script-handler.test.ts | 4 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/board-config-slice-open-warnings.test.ts | 3 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/board-config-slice.test.ts | 9 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/board-config-stop-script.test.ts | 15 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/board-config-validator-fatal-export.test.ts | 3 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/board-config-write-refusal-edges.test.ts | 12 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/board-config-writeback-for-project.test.ts | 5 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/board-config.test.ts | 29 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/board-drop-preview.test.ts | 45 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/board-filter-slice.test.ts | 4 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/board-lane-pin-lifecycle.test.ts | 14 | 0 | 2 | 0/0/0 | board-completing-task-chokepoint | keep | named as a rule enforcement |
| unit/board-manager-predicates.test.ts | 43 | 0 | 6 | 0/0/0 |  | keep | no signal against it |
| unit/board-manager-profiles.test.ts | 17 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/board-manager-save-entry-point.test.ts | 1 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/board-manager-slice.test.ts | 15 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/board-profile-commands.test.ts | 22 | 0 | 6 | 0/0/1 |  | keep | red with a product change in the window |
| unit/board-registry.test.ts | 18 | 0 | 6 | 0/0/0 |  | keep | no signal against it |
| unit/board-store-hmr.test.ts | 4 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/board-store-reload-identity.test.ts | 23 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/board-summary-labels.test.ts | 18 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/board-swimlane-update-restart.test.ts | 15 | 0 | 16 | 0/0/0 |  | keep | no signal against it |
| unit/board-task-facts.test.ts | 8 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/board-turn-end-contracts.test.ts | 12 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/board-workflow.test.ts | 22 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/boards-auth.test.ts | 27 | 0 | 5 | 0/0/0 |  | keep | no signal against it |
| unit/boards-mapping.test.ts | 13 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/boards-rate-limit.test.ts | 8 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/bounded-lru.test.ts | 7 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/bounded-tail-read.test.ts | 5 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/branch-checkout-occupancy.test.ts | 10 | 0 | 5 | 0/0/0 |  | keep | no signal against it |
| unit/branch-git.test.ts | 15 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/branch-pr-resolver.test.ts | 227 | 0 | 16 | 0/0/0 |  | keep | no signal against it |
| unit/branch-summary.test.ts | 22 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/branding-assets.test.ts | 31 | 0 | 10 | 0/0/0 | ui-conventions | keep | named as a rule enforcement |
| unit/bridge-module-import.test.ts | 3 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/bridge-utils.test.ts | 11 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/browser-automation-config.test.ts | 4 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/browser-automation-invariants.test.ts | 2 | 0 | 1 | 0/0/0 | browser-automation-driver | keep | named as a rule enforcement |
| unit/browser-capture-bounds.test.ts | 31 | 0 | 1 | 0/0/0 | browser-automation-driver | keep | named as a rule enforcement |
| unit/browser-clear-storage-handler.test.ts | 48 | 0 | 10 | 0/0/0 |  | keep | no signal against it |
| unit/browser-empty-state-utils.test.ts | 12 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/browser-guest-mouse-forward-wiring.test.ts | 5 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/browser-handler-error-translation.test.ts | 5 | 0 | 1 | 0/0/0 |  | rewritten | asserts its own copy; extract and import the real logic |
| unit/browser-input-focus-emulation.test.ts | 62 | 0 | 7 | 0/0/0 | agent-driven-focus | keep | named as a rule enforcement |
| unit/browser-jar-ensure-handler.test.ts | 6 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/browser-keyboard-focus.test.ts | 14 | 0 | 2 | 0/0/0 | agent-driven-focus | keep | named as a rule enforcement |
| unit/browser-lane-handoff.test.ts | 14 | 0 | 7 | 0/0/0 |  | keep | no signal against it |
| unit/browser-lane-manager.test.ts | 29 | 0 | 13 | 0/0/0 | browser-automation-driver | keep | named as a rule enforcement |
| unit/browser-navigation-registry.test.ts | 4 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/browser-offscreen-close-handler.test.ts | 7 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/browser-opener-host-wiring.test.ts | 3 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/browser-pane-detach.test.ts | 30 | 0 | 2 | 0/0/0 | browser-automation-driver | keep | named as a rule enforcement |
| unit/browser-pane-driver.test.ts | 40 | 0 | 7 | 0/0/0 | agent-driven-focus browser-automation-driver | keep | named as a rule enforcement |
| unit/browser-pane-opener.test.ts | 58 | 0 | 10 | 0/0/0 | browser-automation-driver | keep | named as a rule enforcement |
| unit/browser-pane-registry.test.ts | 94 | 0 | 12 | 0/0/0 | browser-automation-driver | keep | named as a rule enforcement |
| unit/browser-partition-cleanup.test.ts | 16 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/browser-partition.test.ts | 13 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/browser-payload.test.ts | 80 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/browser-screenshot-timeout.test.ts | 4 | 0 | 1 | 0/0/0 | retained-pane-never-remounts | keep | named as a rule enforcement |
| unit/browser-tool-result.test.ts | 12 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/browser-tools-drive-bodies.test.ts | 19 | 0 | 5 | 0/0/1 | agent-driven-focus | keep | named as a rule enforcement |
| unit/browser-url-store.test.ts | 20 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/browser-user-agent.test.ts | 5 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/build-demo-script.test.ts | 12 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/build-esbuild-bundles-sequential-upload.test.ts | 4 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/build-terminal-theme.test.ts | 7 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/build-tools-tooltip.test.ts | 8 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/buildenv-adapter-interface-guard.test.ts | 3 | 0 | 7 | 0/0/0 |  | keep | no signal against it |
| unit/bulk-delete-handler.test.ts | 11 | 0 | 9 | 0/0/0 |  | keep | no signal against it |
| unit/button-cursor-base-rule.test.ts | 3 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/cached-singleton.test.ts | 7 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/capture-agent-scrollback-args.test.ts | 35 | 0 | 3 | 0/0/0 | web-demo-parity | keep | named as a rule enforcement |
| unit/capture-dev-chrome-parity.test.ts | 2 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/capture-git-stats-history.test.ts | 14 | 0 | 5 | 0/0/0 |  | keep | no signal against it |
| unit/capture-own-record-reconcile.test.ts | 2 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/capture-own-record-task-move.test.ts | 3 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/carry-uncommitted-changes-sparse.test.ts | 1 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/carry-uncommitted-changes.test.ts | 10 | 0 | 7 | 0/0/0 |  | keep | no signal against it |
| unit/central-embedding-engine-boundary.test.ts | 3 | 0 | 1 | 0/0/0 | central-embedding-engine | keep | named as a rule enforcement |
| unit/change-record-index.test.ts | 16 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/changes-panel-rail-clamp-parity.test.ts | 3 | 0 | 2 | 0/1/0 |  | keep | no signal against it |
| unit/checkout-branch.test.ts | 35 | 0 | 12 | 0/0/0 |  | keep | no signal against it |
| unit/checkout-guard-single-site.test.ts | 4 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/checkpoint-driver.test.ts | 5 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/child-env-parity.test.ts | 5 | 0 | 2 | 0/0/0 | cross-platform-parity | keep | named as a rule enforcement |
| unit/child-env.test.ts | 8 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/child-tree-stop.test.ts | 18 | 0 | 2 | 0/0/0 | pty-host-out-of-process task-process-tag | keep | named as a rule enforcement |
| unit/chunk-load-error.test.ts | 5 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/chunked-offline-engine.test.ts | 20 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/ci-required-checks.test.ts | 8 | 0 | 4 | 0/0/0 |  | keep | no signal against it |
| unit/ci-workflow-hygiene.test.ts | 48 | 0 | 4 | 0/0/0 | cross-platform-parity test-value | keep | named as a rule enforcement |
| unit/claude-adapter-capabilities.test.ts | 10 | 0 | 5 | 0/0/0 |  | keep | no signal against it |
| unit/claude-adapter-resumed-reads.test.ts | 14 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/claude-answer-retrieval.test.ts | 11 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/claude-background-sessions.test.ts | 51 | 0 | 7 | 0/0/0 | task-process-tag | keep | named as a rule enforcement |
| unit/claude-background-shell-transcript.test.ts | 26 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/claude-background-task-output.test.ts | 9 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/claude-capability-discovery.test.ts | 25 | 0 | 8 | 0/0/0 |  | keep | no signal against it |
| unit/claude-cli-run.test.ts | 23 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/claude-detector.test.ts | 4 | 0 | 4 | 0/0/0 |  | table | 0 of 315 kills on agent-detector.ts are theirs; keep each parser as a row |
| unit/claude-diff-panel.test.ts | 11 | 0 | 4 | 0/0/0 |  | keep | no signal against it |
| unit/claude-exit-behavior.test.ts | 2 | 0 | 1 | 0/0/0 | pty-teardown-grace | keep | named as a rule enforcement |
| unit/claude-json-lock.test.ts | 11 | 0 | 1 | 0/0/0 | pty-teardown-grace | keep | named as a rule enforcement |
| unit/claude-json-result.test.ts | 12 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/claude-model-flag-spelling.test.ts | 18 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/claude-permission-rejection-transcript.test.ts | 15 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/claude-plan-tool-approval.test.ts | 45 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/claude-project-relocation.test.ts | 16 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/claude-session-history-parser.test.ts | 16 | 0 | 7 | 0/0/0 |  | keep | no signal against it |
| unit/claude-startup-failure.test.ts | 8 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/claude-status-parser.test.ts | 41 | 0 | 19 | 0/0/0 |  | keep | no signal against it |
| unit/claude-subscription-fallback.test.ts | 20 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/claude-thinking-signature.test.ts | 32 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/claude-tool-hook-agent-id.test.ts | 10 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/claude-tool-result-tokens.test.ts | 15 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/claude-transcript-locator-search.test.ts | 31 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/claude-transcript-locator.test.ts | 16 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/claude-transcript-parser-incremental.test.ts | 17 | 0 | 5 | 0/0/0 |  | keep | no signal against it |
| unit/claude-transcript-parser.test.ts | 37 | 0 | 10 | 0/0/0 |  | keep | no signal against it |
| unit/claude-transcript-tool-counts.test.ts | 45 | 0 | 10 | 0/0/0 |  | keep | no signal against it |
| unit/claude-transcript-usage.test.ts | 6 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/claude-wsl-spawn.test.ts | 8 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/cli-target.test.ts | 31 | 0 | 9 | 0/0/0 |  | keep | no signal against it |
| unit/clickable-control-select-none.test.ts | 8 | 0 | 3 | 0/0/1 | ui-conventions | keep | named as a rule enforcement |
| unit/client-id.test.ts | 8 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/clipboard-image.test.ts | 13 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/clipboard-write-text-handler.test.ts | 24 | 0 | 5 | 0/0/0 |  | keep | no signal against it |
| unit/code-corpus.test.ts | 50 | 0 | 5 | 0/0/0 |  | keep | no signal against it |
| unit/codex-capability-discovery.test.ts | 9 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/codex-command-injection-verifier.test.ts | 16 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/codex-find-transcript-memo.test.ts | 5 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/codex-home-dir.test.ts | 11 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/codex-hook-overrides.test.ts | 45 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/codex-hook-payload-replay.test.ts | 5 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/codex-project-relocation.test.ts | 9 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/codex-session-history-parser.test.ts | 31 | 0 | 4 | 0/0/0 |  | keep | no signal against it |
| unit/codex-transcript-parser.test.ts | 11 | 0 | 4 | 0/0/0 |  | keep | no signal against it |
| unit/codex-trust-manager.test.ts | 21 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/codex-wsl-spawn.test.ts | 8 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/column-archived-filter-single-source.test.ts | 6 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/column-capacity-entry-order.test.ts | 11 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/column-capacity.test.ts | 26 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/column-commands-create-session-track.test.ts | 14 | 0 | 4 | 0/0/1 |  | keep | red with a product change in the window |
| unit/column-commands-description.test.ts | 54 | 0 | 13 | 0/0/1 | mcp-column-field-parity | keep | named as a rule enforcement |
| unit/column-detail-text-match.test.ts | 5 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/column-message-write.test.ts | 23 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/column-resolver-done-modes.test.ts | 8 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/column-strategy-parity.test.ts | 6 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/column-strategy.test.ts | 44 | 0 | 7 | 0/0/0 |  | keep | no signal against it |
| unit/command-builder.test.ts | 210 | 0 | 55 | 0/0/0 | cross-platform-parity | keep | named as a rule enforcement |
| unit/command-injection-real-capture-extractors.test.ts | 10 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/command-terminal-background-session-wiring.test.ts | 11 | 0 | 1 | 0/0/0 | command-terminal | removed | replaced by a behavior test in register-all-idempotency |
| unit/command-terminal-background-session.test.ts | 13 | 0 | 3 | 0/0/0 | command-terminal task-process-tag | keep | named as a rule enforcement |
| unit/command-terminal-grid-fit.test.ts | 6 | 0 | 2 | 0/0/0 | command-terminal | keep | named as a rule enforcement |
| unit/command-terminal-history-availability-memory.test.ts | 7 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/command-terminal-history-repository-label.test.ts | 4 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/command-terminal-host-arrangement.test.ts | 20 | 0 | 4 | 0/0/0 | command-terminal | keep | named as a rule enforcement |
| unit/command-terminal-leftovers.test.ts | 13 | 0 | 6 | 0/0/0 | command-terminal task-process-tag | keep | named as a rule enforcement |
| unit/command-terminal-name.test.ts | 11 | 0 | 3 | 0/0/0 | command-terminal | keep | named as a rule enforcement |
| unit/command-terminal-namer.test.ts | 15 | 0 | 7 | 0/0/0 | command-terminal | keep | named as a rule enforcement |
| unit/command-terminal-rail.test.ts | 8 | 0 | 1 | 0/0/0 | command-terminal | keep | named as a rule enforcement |
| unit/command-terminal-resume-request.test.ts | 10 | 0 | 2 | 0/0/0 | command-terminal | keep | named as a rule enforcement |
| unit/command-terminal-shortcuts.test.ts | 12 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/command-terminal-summary.test.ts | 15 | 0 | 2 | 0/0/0 | command-terminal | keep | named as a rule enforcement |
| unit/command-window-reconcile.test.ts | 13 | 0 | 2 | 0/0/0 | command-terminal | keep | named as a rule enforcement |
| unit/commit-ceiling.test.ts | 6 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/commit-graph-lane-color.test.ts | 3 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/commit-graph-layout.test.ts | 7 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/commit-graph-parse.test.ts | 7 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/commit-graph-reader.test.ts | 13 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/completed-view-request.test.ts | 8 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/completion-gate.test.ts | 7 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/compose-islands.test.ts | 9 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/composed-width-sampler.test.ts | 12 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/composed-width.test.ts | 25 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/composited-meter-fill.test.ts | 6 | 0 | 3 | 0/0/1 |  | keep | red with a product change in the window |
| unit/compute-period-cutoff.test.ts | 8 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/condition-check-call-link.test.ts | 6 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/config-handler-wiring.test.ts | 39 | 0 | 14 | 0/0/0 |  | keep | no signal against it |
| unit/config-overridable-subset.test.ts | 8 | 0 | 15 | 0/0/0 |  | keep | no signal against it |
| unit/config-store-command-terminal-rail.test.ts | 5 | 0 | 1 | 0/0/0 | command-terminal | keep | named as a rule enforcement |
| unit/config-store-context-windows.test.ts | 11 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/config-store-onboarding-baseline.test.ts | 7 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/config-store-project-override.test.ts | 6 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/config-store-rescan-models.test.ts | 13 | 0 | 6 | 0/0/0 |  | keep | no signal against it |
| unit/config-store-workspace.test.ts | 8 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/confirm-only-command-injection-verifiers.test.ts | 18 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/confirmed-missing.test.ts | 10 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/conpty-console-list.test.ts | 3 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/context-bar-fold.test.ts | 9 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/context-extractor.test.ts | 10 | 0 | 4 | 0/0/0 |  | keep | no signal against it |
| unit/context-menu-placement.test.ts | 5 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/context-packet.test.ts | 10 | 0 | 7 | 0/0/0 |  | keep | no signal against it |
| unit/context-usage-footer.test.ts | 7 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/conversation-event.test.ts | 6 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/conversation-expired-copy.test.ts | 2 | 0 | 4 | 0/0/0 |  | keep | no signal against it |
| unit/conversation-expired-toast.test.ts | 10 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/conversation-gone.test.ts | 25 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/conversation-indexer-chunker-purge.test.ts | 2 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/conversation-indexer-decisions.test.ts | 41 | 0 | 12 | 0/0/0 |  | keep | no signal against it |
| unit/conversation-paging-state.test.ts | 12 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/conversation-paging.test.ts | 26 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/conversation-route-slice.test.ts | 32 | 0 | 4 | 0/0/0 |  | keep | no signal against it |
| unit/conversation-switch-gate.test.ts | 26 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/conversation-usage-cost-allocation.test.ts | 9 | 0 | 4 | 0/0/0 |  | keep | no signal against it |
| unit/conversation-usage-task-models.test.ts | 4 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/conversation-window-bridge.test.ts | 4 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/cookie-jar-routes.test.ts | 4 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/cookie-jar-sharing.test.ts | 3 | 0 | 2 | 0/0/0 | cookie-jar-sharing | keep | named as a rule enforcement |
| unit/cookie-seed.test.ts | 19 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/copilot-adapter-history-paths.test.ts | 7 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/copilot-adapter.test.ts | 46 | 0 | 7 | 0/0/0 |  | keep | no signal against it |
| unit/copilot-answer-stream.test.ts | 7 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/copilot-capability-discovery.test.ts | 10 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/copilot-command-builder.test.ts | 43 | 0 | 8 | 0/0/0 |  | keep | no signal against it |
| unit/copilot-command-injection-verifier.test.ts | 12 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/copilot-detector.test.ts | 13 | 0 | 2 | 0/0/0 |  | removed | its parse cases are rows in adapter-detectors |
| unit/copilot-home.test.ts | 2 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/copilot-hook-bridge.test.ts | 10 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/copilot-hook-manager.test.ts | 45 | 0 | 7 | 0/0/0 |  | keep | no signal against it |
| unit/copilot-project-relocation.test.ts | 7 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/copilot-stream-parser.test.ts | 29 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/copilot-wsl.test.ts | 3 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/counter-snapshot.test.ts | 12 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/crash-capture-host-memory.test.ts | 3 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/create-transition-engine-recap-wiring.test.ts | 8 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/cross-project-mention.test.ts | 9 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/cursor-answer-stream.test.ts | 5 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/cursor-answer-workspace.test.ts | 4 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/cursor-capability-discovery.test.ts | 35 | 0 | 6 | 0/1/0 |  | keep | no signal against it |
| unit/cursor-grok-binary-collision.test.ts | 7 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/cursor-project-mcp-config.test.ts | 22 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/cursor-rules.test.ts | 37 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/cursor-stream-parser.test.ts | 24 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/cursor-transcript-parser.test.ts | 11 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/cursor-wsl.test.ts | 10 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/cycle-targets.test.ts | 20 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/darwin-reader-run-tool-env.test.ts | 2 | 0 | 2 | 0/0/0 | task-process-tag | keep | named as a rule enforcement |
| unit/darwin-run-tool-seam.test.ts | 20 | 0 | 2 | 0/0/0 | task-process-tag | keep | named as a rule enforcement |
| unit/data-table-colgroup.test.ts | 5 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/data-table-sort.test.ts | 23 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/datetime.test.ts | 46 | 0 | 5 | 0/0/0 |  | keep | no signal against it |
| unit/dead-root-orphans.test.ts | 38 | 0 | 4 | 0/0/0 | pty-teardown-grace task-process-tag | keep | named as a rule enforcement |
| unit/deep-merge.test.ts | 21 | 0 | 9 | 0/0/0 |  | keep | no signal against it |
| unit/default-swimlanes-seed-parity.test.ts | 9 | 0 | 5 | 0/0/0 |  | keep | no signal against it |
| unit/deferred-kill.test.ts | 15 | 0 | 2 | 0/0/0 | pty-teardown-grace | keep | named as a rule enforcement |
| unit/deferred-terminal-init.test.ts | 33 | 0 | 6 | 0/0/0 |  | keep | no signal against it |
| unit/delete-task-worktree.test.ts | 16 | 0 | 8 | 0/0/0 |  | keep | no signal against it |
| unit/deliver-message-after-move.test.ts | 6 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/demo-archived-build-refusal.test.ts | 4 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/demo-archived-summaries.test.ts | 35 | 0 | 9 | 0/0/0 | web-demo-parity | keep | named as a rule enforcement |
| unit/demo-boot-mouse-buttons.test.ts | 4 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/demo-browser-send-seeded.test.ts | 7 | 0 | 1 | 0/0/0 | web-demo-parity | keep | named as a rule enforcement |
| unit/demo-browser-send.test.ts | 9 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/demo-cell-widths.test.ts | 3 | 0 | 1 | 0/0/0 | web-demo-parity | keep | named as a rule enforcement |
| unit/demo-choreography-nearest-offset.test.ts | 14 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/demo-claude-model-aliases.test.ts | 5 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/demo-conform-bookkeeping.test.ts | 3 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/demo-dataset-consumer-parity.test.ts | 6 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/demo-dictation-info.test.ts | 3 | 0 | 1 | 0/0/0 | web-demo-parity | keep | named as a rule enforcement |
| unit/demo-dictation-recording-seeded.test.ts | 5 | 0 | 1 | 0/0/0 | web-demo-parity | keep | named as a rule enforcement |
| unit/demo-emulator-disposal.test.ts | 3 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/demo-emulator-paint.test.ts | 9 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/demo-fit-layout-blob.test.ts | 18 | 0 | 4 | 0/0/0 | command-terminal | keep | named as a rule enforcement |
| unit/demo-frame-serializer.test.ts | 12 | 0 | 1 | 0/0/0 | web-demo-parity | keep | named as a rule enforcement |
| unit/demo-guest-pages.test.ts | 14 | 0 | 1 | 0/0/0 | web-demo-parity | keep | named as a rule enforcement |
| unit/demo-heap-read.test.ts | 6 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/demo-history-loader.test.ts | 3 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/demo-knowledge-graph-seeded.test.ts | 28 | 0 | 4 | 0/0/0 | web-demo-parity | keep | named as a rule enforcement |
| unit/demo-launches-no-extensions.test.ts | 6 | 0 | 3 | 0/0/0 | web-demo-parity | keep | named as a rule enforcement |
| unit/demo-layout-choice.test.ts | 16 | 0 | 1 | 0/0/0 | web-demo-parity | keep | named as a rule enforcement |
| unit/demo-mcp-capture.test.ts | 55 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/demo-measure-args.test.ts | 19 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/demo-message-trail-replay.test.ts | 4 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/demo-posters.test.ts | 49 | 0 | 6 | 0/0/0 |  | keep | no signal against it |
| unit/demo-replay-emulator.test.ts | 11 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/demo-replay-timelines.test.ts | 7 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/demo-resume-fixtures-rig-exit.test.ts | 8 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/demo-sanitizer-deep.test.ts | 6 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/demo-scaffold-repo.test.ts | 15 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/demo-scene-rows.test.ts | 19 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/demo-scrollback-cache.test.ts | 3 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/demo-search-everything.test.ts | 8 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/demo-send-loaders.test.ts | 26 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/demo-tiled-frames-loaded.test.ts | 9 | 0 | 4 | 0/0/0 | web-demo-parity | keep | named as a rule enforcement |
| unit/demo-transcript-seeded.test.ts | 6 | 0 | 2 | 0/0/0 | web-demo-parity | keep | named as a rule enforcement |
| unit/demo-variant-clock.test.ts | 3 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/dependency-block-parity.test.ts | 7 | 0 | 4 | 0/0/0 | dependency-block-parity | keep | named as a rule enforcement |
| unit/derived-detail-ownership.test.ts | 5 | 0 | 1 | 0/0/0 | derived-detail-ownership | keep | named as a rule enforcement |
| unit/description-content.test.ts | 6 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/desktop-notification-show.test.ts | 6 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/desktop-notifier.test.ts | 45 | 0 | 9 | 0/0/0 |  | keep | no signal against it |
| unit/detail-owner-registry.test.ts | 19 | 0 | 1 | 0/0/0 | derived-detail-ownership | keep | named as a rule enforcement |
| unit/detect-hardware-tier.test.ts | 10 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/dev-port-allocator.test.ts | 34 | 0 | 5 | 0/0/0 |  | keep | no signal against it |
| unit/dev-port-commands.test.ts | 42 | 0 | 4 | 0/0/0 |  | keep | no signal against it |
| unit/dev-port-ledger-unavailable.test.ts | 7 | 0 | 4 | 0/0/0 |  | keep | no signal against it |
| unit/dev-port-schema.test.ts | 8 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/dev-restart-channel.test.ts | 6 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/dev-server-error.test.ts | 6 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/developer-flag-defaults.test.ts | 14 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/devtools-cdp-image-and-selector.test.ts | 28 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/devtools-inspection-server.test.ts | 31 | 0 | 5 | 0/0/0 |  | keep | no signal against it |
| unit/devtools-install-terminal-trace.test.ts | 4 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/devtools-lag-recorder.test.ts | 12 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/devtools-lockfile.test.ts | 6 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/devtools-preview-stores.test.ts | 2 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/devtools-query-all.test.ts | 11 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/devtools-screenshot-budget.test.ts | 33 | 0 | 3 | 0/0/0 | browser-automation-driver | keep | named as a rule enforcement |
| unit/devtools-screenshot-prune.test.ts | 8 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/devtools-selector-parser.test.ts | 19 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/devtools-store-state.test.ts | 24 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/devtools-terminal-forensics.test.ts | 8 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/devtools-terminal-state.test.ts | 9 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/diagnostics-async-file-queue.test.ts | 33 | 0 | 4 | 0/0/0 |  | keep | no signal against it |
| unit/diagnostics-crash-capture.test.ts | 7 | 0 | 5 | 0/0/0 |  | keep | no signal against it |
| unit/diagnostics-debug-dump-resolver.test.ts | 5 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/diagnostics-ipc-recorder.test.ts | 16 | 0 | 7 | 0/0/0 |  | keep | no signal against it |
| unit/diagnostics-log-mirror.test.ts | 14 | 0 | 8 | 0/0/0 |  | keep | no signal against it |
| unit/diagnostics-source-map-resolver.test.ts | 5 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/dialog-form-primitives.test.ts | 7 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/dialog-maximize.test.ts | 12 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/dialog-select-folder-options-scoping.test.ts | 8 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/dictation-anchor.test.ts | 13 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/dictation-client.test.ts | 44 | 0 | 8 | 0/0/0 |  | keep | no signal against it |
| unit/dictation-info.test.ts | 15 | 0 | 3 | 0/0/0 | web-demo-parity | keep | named as a rule enforcement |
| unit/dictation-languages.test.ts | 13 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/dictation-live-slot-integration.test.ts | 7 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/dictation-presets.test.ts | 18 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/dictation-preview-case.test.ts | 12 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/dictation-script-pins.test.ts | 15 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/dictation-sink.test.ts | 20 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/dictation-target.test.ts | 30 | 0 | 6 | 0/0/0 |  | keep | no signal against it |
| unit/dictation-worker.test.ts | 23 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/diff-clipboard.test.ts | 13 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/diff-content.test.ts | 27 | 0 | 5 | 0/0/0 |  | keep | no signal against it |
| unit/diff-error-boundary.test.ts | 1 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/diff-render-options.test.ts | 18 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/diff-scroll-memory.test.ts | 18 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/diff-service-image-real-git.test.ts | 5 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/diff-service.test.ts | 100 | 0 | 23 | 0/0/0 |  | keep | no signal against it |
| unit/diff-subscription-registry.test.ts | 8 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/diff-viewer-snapshot.test.ts | 8 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/diff-watcher-gitdir-cache-race.test.ts | 1 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/diff-watcher.test.ts | 33 | 0 | 9 | 0/0/0 |  | keep | no signal against it |
| unit/directive-builders.test.ts | 45 | 0 | 6 | 0/0/0 |  | keep | no signal against it |
| unit/directive-wiring.test.ts | 5 | 0 | 10 | 0/0/0 |  | keep | no signal against it |
| unit/directory-move.test.ts | 11 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/display-rows-reconcile.test.ts | 15 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/dnd-sensor-options.test.ts | 2 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/docs-bundle.test.ts | 61 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/docs-links.test.ts | 10 | 0 | 4 | 0/0/0 |  | keep | no signal against it |
| unit/docs-path-citations.test.ts | 4 | 0 | 8 | 0/0/0 |  | keep | no signal against it |
| unit/document-image-fetch.test.ts | 24 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/dogfood-launcher-ascii.test.ts | 1 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/dogfood-launcher-gitignore-parity.test.ts | 2 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/dompurify-override.test.ts | 7 | 0 | 4 | 0/0/0 | dependency-block-parity | keep | named as a rule enforcement |
| unit/done-move-bookkeeping.test.ts | 6 | 0 | 2 | 0/0/0 |  | rewritten | pins one importable file's text |
| unit/drain-auto-name-asked-ids.test.ts | 7 | 0 | 6 | 0/0/0 |  | keep | no signal against it |
| unit/drive-telemetry.test.ts | 6 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/droid-capability-discovery.test.ts | 4 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/droid-project-relocation.test.ts | 5 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/droid-transcript-cleanup.test.ts | 17 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/droid-transcript-parser.test.ts | 22 | 0 | 5 | 0/0/0 |  | keep | no signal against it |
| unit/droid-wsl.test.ts | 5 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/e2e-janitor.test.ts | 33 | 0 | 4 | 0/0/0 |  | keep | no signal against it |
| unit/e2e-mock-cli-platform.test.ts | 2 | 0 | 1 | 0/1/0 |  | keep | no signal against it |
| unit/earlier-run-fill-overtakes-queue.test.ts | 2 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/earlier-runs-edge-cases.test.ts | 4 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/earlier-search.test.ts | 8 | 0 | 1 | 0/0/0 | command-terminal | keep | named as a rule enforcement |
| unit/early-agent-engine.test.ts | 29 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/early-agent-launch-key.test.ts | 24 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/early-agent-launch.test.ts | 13 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/early-agent-launcher.test.ts | 59 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/electron-desktop-z-floor.test.ts | 4 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/embed-client.test.ts | 41 | 0 | 13 | 0/0/0 |  | keep | no signal against it |
| unit/embed-worker.test.ts | 7 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/embedded-signin-refusal.test.ts | 9 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/embedding-models.test.ts | 9 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/embedding-runtime.test.ts | 9 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/embedding-script-pins.test.ts | 2 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/encrypted-secret-file.test.ts | 17 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/engine-build.test.ts | 11 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/engine-selection.test.ts | 42 | 0 | 9 | 0/0/0 |  | keep | no signal against it |
| unit/ensure-git-repo.test.ts | 13 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/ensure-node-modules.test.ts | 40 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/error-reporting-renderer.test.ts | 7 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/error-reporting-switch.test.ts | 49 | 0 | 18 | 0/0/0 |  | keep | no signal against it |
| unit/esbuild-cjs-imports.test.ts | 1 | 0 | 1 | 0/0/0 | esbuild-cjs-imports | keep | named as a rule enforcement |
| unit/escape-ownership.test.ts | 13 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/eval-answer-models.test.ts | 38 | 0 | 5 | 0/0/0 |  | keep | no signal against it |
| unit/eval-ask-rollup.test.ts | 8 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/eval-condition-check.test.ts | 30 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/eval-docs-reads.test.ts | 96 | 0 | 4 | 0/0/0 |  | removed | tests a one-off measurement; goes with its script |
| unit/event-bridge-error-log.test.ts | 5 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/event-bridge-prompt-capture.test.ts | 6 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/event-bridge-stop-plan-mode.test.ts | 4 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/event-bridge-wait-kind.test.ts | 29 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/event-loop-lag.test.ts | 21 | 0 | 4 | 0/0/0 |  | keep | no signal against it |
| unit/existing-project-db.test.ts | 4 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/exit-message-delivery.test.ts | 8 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/exit-sequence.test.ts | 5 | 0 | 1 | 0/0/0 | pty-teardown-grace | keep | named as a rule enforcement |
| unit/exited-console-input.test.ts | 5 | 0 | 2 | 0/0/0 | pty-teardown-grace | keep | named as a rule enforcement |
| unit/exited-root-wait.test.ts | 22 | 0 | 2 | 0/0/0 | pty-teardown-grace task-process-tag | keep | named as a rule enforcement |
| unit/expired-conversation-recap-budget.test.ts | 14 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/expired-conversation-recap.test.ts | 30 | 0 | 4 | 0/0/0 |  | keep | no signal against it |
| unit/expired-recap-sources.test.ts | 14 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/external-scripts-parity.test.ts | 7 | 0 | 1 | 0/0/0 | external-scripts-parity | keep | named as a rule enforcement |
| unit/external-url.test.ts | 25 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/fallback-paths.test.ts | 12 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/fetch-throttle.test.ts | 43 | 0 | 9 | 0/0/0 |  | keep | no signal against it |
| unit/file-history-reader.test.ts | 10 | 0 | 4 | 0/0/0 |  | keep | no signal against it |
| unit/file-watcher-recovery.test.ts | 2 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/file-watcher-storm-guard.test.ts | 3 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/file-watcher.test.ts | 24 | 0 | 5 | 0/0/0 |  | keep | no signal against it |
| unit/final-line-match.test.ts | 39 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/final-reply-reader-reported-path.test.ts | 2 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/find-live-session-in-directory.test.ts | 4 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/first-output-tracker.test.ts | 13 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/first-prompt-typed-parity.test.ts | 17 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/fit-addon.test.ts | 36 | 0 | 6 | 0/0/0 |  | keep | no signal against it |
| unit/focused-sessions.test.ts | 36 | 0 | 8 | 0/0/0 |  | keep | no signal against it |
| unit/focused-terminals.test.ts | 10 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/folding-edge-drag.test.ts | 4 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/font-resolver.test.ts | 5 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/foreign-crash-real-client.test.ts | 5 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/format-session.test.ts | 23 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/format-tokens.test.ts | 42 | 0 | 7 | 0/0/0 |  | keep | no signal against it |
| unit/fresh-agent-session-id.test.ts | 7 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/fs-watch-sites-guard.test.ts | 2 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/gemini-answer-stream.test.ts | 8 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/gemini-capability-discovery.test.ts | 8 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/gemini-command-builder.test.ts | 44 | 0 | 10 | 0/0/0 |  | keep | no signal against it |
| unit/gemini-detector.test.ts | 5 | 0 | 4 | 0/0/0 |  | table | 0 of 315 kills on agent-detector.ts are theirs; keep each parser as a row |
| unit/gemini-home.test.ts | 2 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/gemini-hook-manager.test.ts | 10 | 0 | 7 | 0/0/0 |  | keep | no signal against it |
| unit/gemini-project-relocation.test.ts | 9 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/gemini-status-parser.test.ts | 4 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/gemini-transcript-parser.test.ts | 13 | 0 | 5 | 0/0/0 |  | keep | no signal against it |
| unit/gemini-trust-manager.test.ts | 19 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/gemini-wsl.test.ts | 6 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/get-current-task.test.ts | 20 | 0 | 4 | 0/0/0 |  | keep | no signal against it |
| unit/get-last-project-overrides.test.ts | 4 | 0 | 6 | 0/0/0 |  | keep | no signal against it |
| unit/get-task-report-command.test.ts | 9 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/gh-client-import.test.ts | 5 | 0 | 4 | 0/0/0 |  | keep | no signal against it |
| unit/git-branches.test.ts | 6 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/git-client.test.ts | 11 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/git-detector-minimum.test.ts | 12 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/git-diff-subscription-handler.test.ts | 20 | 0 | 8 | 0/0/0 |  | keep | no signal against it |
| unit/git-exclude.test.ts | 8 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/git-fetch-scheduler.test.ts | 12 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/git-lifecycle-off-main.test.ts | 1 | 0 | 1 | 0/0/0 | pty-host-out-of-process | keep | named as a rule enforcement |
| unit/git-object-reader-stream.test.ts | 10 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/git-pending-changes.test.ts | 16 | 0 | 4 | 0/0/0 |  | keep | no signal against it |
| unit/git-read-queue.test.ts | 3 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/git-remotes.test.ts | 14 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/git-spawn-env.test.ts | 2 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/git-task-changes-handler.test.ts | 20 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/git-utils.test.ts | 14 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/git-version.test.ts | 18 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/git-worktree-list.test.ts | 9 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/github-pr-detector.test.ts | 25 | 0 | 5 | 0/0/0 |  | keep | no signal against it |
| unit/github-remote.test.ts | 24 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/global-db-degradation.test.ts | 32 | 0 | 5 | 0/0/0 |  | keep | no signal against it |
| unit/goose-adapter.test.ts | 56 | 0 | 6 | 0/0/0 |  | keep | no signal against it |
| unit/goose-program-status-parser.test.ts | 12 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/gpu-escalation-report-wiring.test.ts | 21 | 0 | 9 | 0/0/0 |  | keep | no signal against it |
| unit/gpu-notice.test.ts | 6 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/graph-facade.test.ts | 20 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/graph-service-coverage-cache.test.ts | 9 | 0 | 4 | 0/1/0 |  | keep | no signal against it |
| unit/graph-service-mark-dirty.test.ts | 24 | 0 | 4 | 0/0/0 |  | keep | no signal against it |
| unit/graph-service-snapshot-wire.test.ts | 5 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/graph-service-summary-source-fallback.test.ts | 2 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/grok-capability-discovery-help-fallback.test.ts | 9 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/grok-probe-auth.test.ts | 5 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/grok-wsl.test.ts | 6 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/guarded-sync-write-call-sites.test.ts | 3 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/guarded-sync-writes.test.ts | 11 | 0 | 3 | 0/0/0 | guarded-sync-writes | keep | named as a rule enforcement |
| unit/guest-drive-queue.test.ts | 8 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/guest-text-target.test.ts | 11 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/handoff-repository.test.ts | 6 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/hard-shutdown-failsafe.test.ts | 4 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/header-pill-overflow.test.ts | 5 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/headless-frame.test.ts | 20 | 0 | 10 | 0/0/0 | xterm-unicode11-parity | keep | named as a rule enforcement |
| unit/held-messages-wiring.test.ts | 18 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/held-pause.test.ts | 9 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/history-read-queue.test.ts | 5 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/history-scan.test.ts | 20 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/hmr-generation.test.ts | 8 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/hmr-resync.test.ts | 4 | 0 | 28 | 0/0/0 | hmr-patterns pop-out-surface-registry | keep | named as a rule enforcement |
| unit/hook-cleanup-packaged-paths.test.ts | 6 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/hook-detail-cap-parity.test.ts | 2 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/hook-manager.test.ts | 16 | 0 | 31 | 0/0/0 |  | keep | no signal against it |
| unit/hook-shaped-locals.test.ts | 5 | 0 | 4 | 0/0/0 | hmr-patterns retained-pane-never-remounts | keep | named as a rule enforcement |
| unit/host-cli-processes.test.ts | 14 | 0 | 3 | 0/0/0 | pty-host-out-of-process | keep | named as a rule enforcement |
| unit/host-memory-store.test.ts | 27 | 0 | 7 | 0/0/0 |  | keep | no signal against it |
| unit/host-memory.test.ts | 56 | 0 | 6 | 0/0/0 |  | keep | no signal against it |
| unit/host-process-table.test.ts | 5 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/hybrid-engine.test.ts | 21 | 0 | 4 | 0/0/0 |  | keep | no signal against it |
| unit/i18n-catalog-loading.test.ts | 16 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/i18n-catalogs-script.test.ts | 16 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/i18n-english-defaults.test.ts | 8 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/i18n-english-readers.test.ts | 16 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/i18n-hardcoded-text.test.ts | 14 | 0 | 3 | 0/0/0 | i18n | keep | named as a rule enforcement |
| unit/i18n-locales.test.ts | 42 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/i18n-placeholder-backslash-guard.test.ts | 6 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/i18n-translation-engines.test.ts | 23 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/i18n-translation-harness.test.ts | 77 | 0 | 4 | 0/0/0 |  | keep | no signal against it |
| unit/icon-slot.test.ts | 5 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/idle-agent-pause.test.ts | 37 | 0 | 3 | 0/0/0 | command-terminal task-process-tag | keep | named as a rule enforcement |
| unit/idle-toast.test.ts | 19 | 0 | 4 | 0/0/0 |  | keep | no signal against it |
| unit/image-compress.test.ts | 10 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/image-fidelity.test.ts | 8 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/image-preview.test.ts | 10 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/import-reconcile.test.ts | 26 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/incoming-write-queue.test.ts | 28 | 0 | 9 | 0/0/0 |  | keep | no signal against it |
| unit/index-builds-quiet.test.ts | 6 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/index-counts.test.ts | 12 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/index-panel-lines.test.ts | 22 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/index-sources.test.ts | 26 | 0 | 4 | 0/0/0 |  | keep | no signal against it |
| unit/index-status-read-all-yield.test.ts | 6 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/index-summary.test.ts | 16 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/indexed-conversation-nodes.test.ts | 4 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/injection-plan.test.ts | 86 | 0 | 20 | 0/0/0 |  | keep | no signal against it |
| unit/inspect-commands.test.ts | 61 | 0 | 13 | 0/0/0 |  | keep | no signal against it |
| unit/install-spawn-helper.test.ts | 38 | 0 | 4 | 0/0/0 |  | keep | no signal against it |
| unit/intent-keyboard-sensor.test.ts | 15 | 0 | 1 | 0/0/0 | keyboard-drag-intent | keep | named as a rule enforcement |
| unit/inventory-commands-list-columns.test.ts | 11 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/inventory-commands-list-tasks.test.ts | 3 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/ipc-error.test.ts | 12 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/ipc-handler-wiring.test.ts | 10 | 0 | 15 | 0/0/0 |  | keep | no signal against it |
| unit/is-entrypoint.test.ts | 8 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/is-same-path.test.ts | 6 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/jar-seeder.test.ts | 12 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/jsonl-history-page.test.ts | 26 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/jsonl-window-stream.test.ts | 16 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/kangentic-hook-recognition.test.ts | 12 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/kangentic-mcp-delivery.test.ts | 31 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/kangentic-mcp-server.test.ts | 4 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/keybindings-matcher.test.ts | 58 | 0 | 4 | 0/0/0 |  | keep | no signal against it |
| unit/keybindings-probe-handler.test.ts | 12 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/keybindings-registry.test.ts | 39 | 0 | 7 | 0/0/0 | keybindings-registry | keep | named as a rule enforcement |
| unit/kimi-adapter.test.ts | 76 | 0 | 9 | 0/0/0 |  | keep | no signal against it |
| unit/kimi-capability-discovery.test.ts | 5 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/kimi-project-relocation.test.ts | 8 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/kimi-session-history-parser.test.ts | 17 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/kimi-transcript-cleanup.test.ts | 7 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/kimi-transcript-parser.test.ts | 11 | 0 | 5 | 0/0/0 |  | keep | no signal against it |
| unit/kimi-wire-parser.test.ts | 93 | 0 | 6 | 0/0/0 |  | keep | no signal against it |
| unit/kimi-wire-telemetry.test.ts | 3 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/knowledge-graph-answer-handler.test.ts | 73 | 0 | 6 | 0/0/0 |  | keep | no signal against it |
| unit/knowledge-graph-answer-markdown.test.ts | 29 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/knowledge-graph-answer-tasks.test.ts | 29 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/knowledge-graph-color-modes.test.ts | 6 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/knowledge-graph-coverage.test.ts | 10 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/knowledge-graph-edge-strength.test.ts | 5 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/knowledge-graph-framing.test.ts | 15 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/knowledge-graph-granularity-options.test.ts | 5 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/knowledge-graph-hover-facts.test.ts | 7 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/knowledge-graph-layout.test.ts | 34 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/knowledge-graph-node-set-key.test.ts | 6 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/knowledge-graph-region-count.test.ts | 14 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/knowledge-graph-region-names.test.ts | 20 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/knowledge-graph-seed-vectors.test.ts | 9 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/knowledge-graph-stepwise.test.ts | 5 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/knowledge-graph-store.test.ts | 57 | 0 | 4 | 0/0/0 |  | keep | no signal against it |
| unit/knowledge-graph-task-fields.test.ts | 30 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/known-models.test.ts | 1 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/lane-pin-slice.test.ts | 6 | 0 | 1 | 0/0/0 | board-completing-task-chokepoint | keep | named as a rule enforcement |
| unit/launcher-linux-artifact-selection.test.ts | 32 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/launcher-macos-floor.test.ts | 5 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/launcher-version.test.ts | 10 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/leftover-process-reports.test.ts | 14 | 0 | 3 | 0/0/0 | task-process-tag | keep | named as a rule enforcement |
| unit/leftover-process-stop-handler.test.ts | 18 | 0 | 4 | 0/0/0 | task-process-tag | keep | named as a rule enforcement |
| unit/leftover-processes-copy.test.ts | 19 | 0 | 5 | 0/0/0 | task-process-tag | keep | named as a rule enforcement |
| unit/leftover-processes-store.test.ts | 30 | 0 | 4 | 0/0/0 | task-process-tag | keep | named as a rule enforcement |
| unit/leftover-sweep-options.test.ts | 8 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/leftover-worktree-retry.test.ts | 12 | 0 | 4 | 0/0/0 | task-process-tag | keep | named as a rule enforcement |
| unit/leg-deltas.test.ts | 8 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/legacy-git-keys.test.ts | 9 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/legacy-idle-timeout.test.ts | 5 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/legacy-memory-keys.test.ts | 5 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/light-dismiss-action-cursor.test.ts | 3 | 0 | 2 | 0/0/0 | light-dismiss-denylist | keep | named as a rule enforcement |
| unit/light-dismiss-resolve-targets.test.ts | 16 | 0 | 4 | 0/0/0 |  | keep | no signal against it |
| unit/line-count-client.test.ts | 16 | 0 | 7 | 0/0/0 |  | keep | no signal against it |
| unit/link-node-modules.test.ts | 8 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/linux-gpu-zygote.test.ts | 19 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/linux-package-deps.test.ts | 5 | 0 | 1 | 0/0/0 | linux-package-dependencies | keep | named as a rule enforcement |
| unit/list-remote-branches-fetch.test.ts | 3 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/list-sessions-leg-shares.test.ts | 5 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/load-ambient-board.test.ts | 2 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/local-connections.test.ts | 8 | 0 | 1 | 0/0/0 | task-process-tag | keep | named as a rule enforcement |
| unit/local-only-commits.test.ts | 11 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/locate-transcript-source.test.ts | 5 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/lockfile-integrity.test.ts | 9 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/looks-like-shell-id.test.ts | 24 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/low-memory-agent-pauser.test.ts | 17 | 0 | 5 | 0/0/0 |  | keep | no signal against it |
| unit/main-callers-reported-path.test.ts | 19 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/main-hot-path-sync-io.test.ts | 2 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/manager-resize-gate.test.ts | 21 | 0 | 5 | 0/0/0 | command-terminal | keep | named as a rule enforcement |
| unit/markdown-document-render.test.ts | 24 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/markdown-document-sources.test.ts | 27 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/markdown-editing.test.ts | 39 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/markdown-on-control-pairing.test.ts | 4 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/markdown-paste-html.test.ts | 7 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/markdown-preview-highlight.test.ts | 10 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/markdown-repo-link.test.ts | 14 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/mcp-attachment-handlers.test.ts | 10 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/mcp-browser-tools-project-scope.test.ts | 9 | 0 | 4 | 0/0/1 | browser-automation-driver | keep | named as a rule enforcement |
| unit/mcp-caller-url.test.ts | 5 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/mcp-column-field-parity.test.ts | 5 | 0 | 6 | 0/0/0 | mcp-column-field-parity | keep | named as a rule enforcement |
| unit/mcp-connection-check.test.ts | 25 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/mcp-connection-watch.test.ts | 4 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/mcp-create-task-branch-conflict.test.ts | 13 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/mcp-create-task-labels.test.ts | 8 | 0 | 7 | 0/0/0 |  | keep | no signal against it |
| unit/mcp-diagnostics-tools-worktree-base.test.ts | 1 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/mcp-get-recent-crashes-fallback.test.ts | 2 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/mcp-http-server-browser-scope.test.ts | 2 | 0 | 4 | 0/0/0 |  | keep | no signal against it |
| unit/mcp-http-server-steering-lifecycle.test.ts | 9 | 0 | 3 | 0/0/1 |  | keep | red with a product change in the window |
| unit/mcp-http-server-track-feature-used.test.ts | 4 | 0 | 1 | 0/0/1 |  | keep | red with a product change in the window |
| unit/mcp-labels-absent-notice.test.ts | 15 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/mcp-list-columns-rendering.test.ts | 8 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/mcp-move-task-own-session-note.test.ts | 5 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/mcp-move-task-to-done.test.ts | 6 | 0 | 7 | 0/0/0 |  | keep | no signal against it |
| unit/mcp-plan-approval-passthrough.test.ts | 8 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/mcp-profile-tools-schema.test.ts | 6 | 0 | 4 | 0/0/1 |  | keep | red with a product change in the window |
| unit/mcp-project-resolver-worktree-base.test.ts | 6 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/mcp-project-resolver.test.ts | 25 | 0 | 6 | 0/0/0 |  | keep | no signal against it |
| unit/mcp-project-tools.test.ts | 6 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/mcp-request-path-parsing.test.ts | 6 | 0 | 1 | 0/0/1 |  | keep | red with a product change in the window |
| unit/mcp-running-work-guard-wiring.test.ts | 10 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/mcp-server-config-gating.test.ts | 14 | 0 | 7 | 0/0/1 |  | keep | red with a product change in the window |
| unit/mcp-server-handler.test.ts | 14 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/mcp-server-instructions-browser.test.ts | 14 | 0 | 5 | 0/0/0 | browser-automation-driver | keep | named as a rule enforcement |
| unit/mcp-server-instructions.test.ts | 10 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/mcp-server-network-config.test.ts | 10 | 0 | 2 | 0/0/1 |  | keep | red with a product change in the window |
| unit/mcp-session-send.test.ts | 33 | 0 | 4 | 0/0/0 |  | keep | no signal against it |
| unit/mcp-spawn-override-validation.test.ts | 32 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/mcp-steering-tools.test.ts | 32 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/mcp-tail-logs-fallback.test.ts | 4 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/mcp-task-counter.test.ts | 4 | 0 | 4 | 0/0/0 |  | keep | no signal against it |
| unit/mcp-task-placement-handlers.test.ts | 46 | 0 | 5 | 0/0/0 |  | keep | no signal against it |
| unit/mcp-task-placement-schema.test.ts | 12 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/mcp-task-pr-fields.test.ts | 57 | 0 | 14 | 0/0/0 |  | keep | no signal against it |
| unit/mcp-task-tools-automations-disabled-wiring.test.ts | 13 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/mcp-task-tools-pr-fields-schema.test.ts | 14 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/mcp-task-tools-run-mode-schema.test.ts | 4 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/mcp-task-tools-run-mode-wiring.test.ts | 8 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/mcp-task-tools-task-report-wiring.test.ts | 10 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/mcp-tool-call-logging.test.ts | 33 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/mcp-tool-docs-url.test.ts | 3 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/mcp-tool-list-parity.test.ts | 12 | 0 | 9 | 0/0/0 | mcp-tool-list-parity | keep | named as a rule enforcement |
| unit/mcp-update-task-description-edits.test.ts | 32 | 0 | 5 | 0/0/0 |  | keep | no signal against it |
| unit/mcp-workflow-tools-caller.test.ts | 2 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/mcp-workflow-tools-task-cap.test.ts | 3 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/measure-docs-structure.test.ts | 54 | 0 | 3 | 0/0/0 |  | removed | tests a one-off measurement; goes with its script |
| unit/memory-chunks-indexes.test.ts | 12 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/memory-search-degradation.test.ts | 11 | 0 | 4 | 0/0/0 |  | keep | no signal against it |
| unit/memory-search-mark-range.test.ts | 6 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/memory-search-relevance.test.ts | 6 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/memory-search-task-scope.test.ts | 3 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/merge-mac-update-feeds.test.ts | 30 | 0 | 1 | 0/0/0 | release-gates-fail-loudly | keep | named as a rule enforcement |
| unit/merge-tool-breakdowns.test.ts | 11 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/message-delivery-pending.test.ts | 5 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/message-preview.test.ts | 14 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/message-trail-extract-build-trail.test.ts | 9 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/message-trail-extract-errors.test.ts | 3 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/message-trail-extract-opencode-candidates.test.ts | 1 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/message-trail-extract-pasted.test.ts | 11 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/message-trail-ipc-wiring.test.ts | 8 | 0 | 6 | 0/0/0 |  | keep | no signal against it |
| unit/message-trail-read-final-reply.test.ts | 12 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/metrics-snapshot-timer.test.ts | 16 | 0 | 5 | 0/0/0 |  | keep | no signal against it |
| unit/mobile-bridge/answer-permission-prompt.test.ts | 11 | 0 | 4 | 0/0/0 |  | keep | no signal against it |
| unit/mobile-bridge/board-event-bus.test.ts | 6 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/mobile-bridge/board-tool-allowlist.test.ts | 8 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/mobile-bridge/board-tool.test.ts | 13 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/mobile-bridge/capability-router.test.ts | 10 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/mobile-bridge/command-terminal.test.ts | 21 | 0 | 6 | 0/0/0 | activity-marks command-terminal | keep | named as a rule enforcement |
| unit/mobile-bridge/dev-quick-pair-gate.test.ts | 4 | 0 | 6 | 0/0/0 |  | keep | no signal against it |
| unit/mobile-bridge/expo-push-client.test.ts | 12 | 0 | 5 | 0/0/0 |  | keep | no signal against it |
| unit/mobile-bridge/handlers-registration.test.ts | 1 | 0 | 6 | 0/0/0 |  | keep | no signal against it |
| unit/mobile-bridge/identity.test.ts | 21 | 0 | 5 | 0/0/0 |  | keep | no signal against it |
| unit/mobile-bridge/interactive-terminal.test.ts | 11 | 0 | 6 | 0/0/0 |  | keep | no signal against it |
| unit/mobile-bridge/mobile-bridge-ipc-handler.test.ts | 27 | 0 | 7 | 0/0/0 |  | keep | no signal against it |
| unit/mobile-bridge/mobile-bridge-relay-state.test.ts | 13 | 0 | 8 | 0/0/0 |  | keep | no signal against it |
| unit/mobile-bridge/mobile-bridge-service.test.ts | 38 | 0 | 15 | 0/0/0 |  | keep | no signal against it |
| unit/mobile-bridge/mobile-bridge-session-lifecycle.test.ts | 66 | 0 | 20 | 0/0/0 |  | keep | no signal against it |
| unit/mobile-bridge/mobile-bridge-sync-race.test.ts | 2 | 0 | 8 | 0/0/0 |  | keep | no signal against it |
| unit/mobile-bridge/move-task.test.ts | 7 | 0 | 4 | 0/0/0 |  | keep | no signal against it |
| unit/mobile-bridge/pairing-service.test.ts | 21 | 0 | 13 | 0/0/0 |  | keep | no signal against it |
| unit/mobile-bridge/pairing-token.test.ts | 5 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/mobile-bridge/pause-session.test.ts | 16 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/mobile-bridge/power-monitor-wiring.test.ts | 2 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/mobile-bridge/project-color.test.ts | 4 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/mobile-bridge/prompt-options-probe.test.ts | 17 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/mobile-bridge/push-clear-ledger.test.ts | 26 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/mobile-bridge/push-notifier.test.ts | 105 | 0 | 14 | 0/0/0 |  | keep | no signal against it |
| unit/mobile-bridge/push-registration-store.test.ts | 9 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/mobile-bridge/read-board.test.ts | 37 | 0 | 20 | 0/0/0 |  | keep | no signal against it |
| unit/mobile-bridge/read-diff.test.ts | 13 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/mobile-bridge/register-push.test.ts | 8 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/mobile-bridge/relay-pairing-integration.test.ts | 2 | 0 | 6 | 0/0/0 |  | keep | no signal against it |
| unit/mobile-bridge/relay-websocket.test.ts | 18 | 0 | 4 | 0/0/0 |  | keep | no signal against it |
| unit/mobile-bridge/roster-store-real-disk.test.ts | 3 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/mobile-bridge/roster-store.test.ts | 14 | 0 | 4 | 0/0/0 |  | keep | no signal against it |
| unit/mobile-bridge/send-event.test.ts | 6 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/mobile-bridge/send-user-message.test.ts | 10 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/mobile-bridge/session-lifecycle-feed.test.ts | 16 | 0 | 5 | 0/0/0 |  | keep | no signal against it |
| unit/mobile-bridge/session-refusals.test.ts | 6 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/mobile-bridge/spawn-progress-feed.test.ts | 18 | 0 | 4 | 0/0/0 |  | keep | no signal against it |
| unit/mobile-bridge/spawn-stall-watcher.test.ts | 6 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/mobile-bridge/start-session-resume-path.test.ts | 21 | 0 | 7 | 0/0/0 |  | keep | no signal against it |
| unit/mobile-bridge/start-session.test.ts | 9 | 0 | 6 | 0/0/0 |  | keep | no signal against it |
| unit/mobile-bridge/subscription-registry.test.ts | 5 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/mobile-bridge/transcript-sync-archive.test.ts | 6 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/mobile-bridge/transcript-sync.test.ts | 15 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/mobile-bridge/transport-factory.test.ts | 8 | 0 | 5 | 0/0/0 |  | keep | no signal against it |
| unit/mobile-bridge/verbs-parity.test.ts | 1 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/mobile-bridge/wire-mappers-activity-reason.test.ts | 3 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/mobile-bridge/wire-mappers-transcript-blocks.test.ts | 6 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/mobile-bridge/wire-mappers-transcript-system-subtype.test.ts | 3 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/mobile-bridge/wire-mappers.test.ts | 43 | 0 | 16 | 0/0/0 |  | keep | no signal against it |
| unit/mobile-bridge/workflow-wire.test.ts | 9 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/mobile-capability-verbs-parity.test.ts | 3 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/mobile-store.test.ts | 21 | 0 | 4 | 0/0/0 |  | keep | no signal against it |
| unit/mock-agent-list-parity.test.ts | 5 | 0 | 6 | 0/0/0 |  | keep | no signal against it |
| unit/mock-electron-api-parity.test.ts | 3 | 0 | 3 | 0/0/0 | web-demo-parity | keep | named as a rule enforcement |
| unit/mock-electron-api-workflow-boards.test.ts | 36 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/mock-electron-api-worktree-fixtures.test.ts | 4 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/model-display-name.test.ts | 22 | 0 | 4 | 0/0/0 |  | keep | no signal against it |
| unit/model-id.test.ts | 52 | 0 | 5 | 0/0/0 |  | keep | no signal against it |
| unit/model-licenses.test.ts | 4 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/model-registry.test.ts | 52 | 0 | 6 | 0/0/0 |  | keep | no signal against it |
| unit/monaco-error-funnel.test.ts | 30 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/monitor-aggregator.test.ts | 41 | 0 | 10 | 0/0/0 |  | keep | no signal against it |
| unit/monitor-peek-subscribe-handler.test.ts | 8 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/monitor-peek-tracker.test.ts | 18 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/monitor-push-gate.test.ts | 16 | 0 | 4 | 0/0/0 |  | keep | no signal against it |
| unit/monitor-rows.test.ts | 7 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/monitor-snapshot-sources.test.ts | 7 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/monitor-store.test.ts | 37 | 0 | 6 | 0/0/0 |  | keep | no signal against it |
| unit/monitor-surface-config-guard.test.ts | 14 | 0 | 5 | 0/0/0 |  | keep | no signal against it |
| unit/monitor-view-model.test.ts | 42 | 0 | 6 | 0/0/0 |  | keep | no signal against it |
| unit/monitor-workspace-restore.test.ts | 14 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/motion-reduced.test.ts | 5 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/mouse-chord-keybindings.test.ts | 7 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/move-from-row.test.ts | 15 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/move-worktree-aside.test.ts | 5 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/native-crash-event.test.ts | 50 | 0 | 6 | 0/0/0 |  | keep | no signal against it |
| unit/native-crash-install-root.test.ts | 5 | 0 | 4 | 0/0/0 |  | keep | no signal against it |
| unit/native-title.test.ts | 14 | 0 | 6 | 0/0/0 | one-tooltip | keep | named as a rule enforcement |
| unit/navigate-to-vite.test.ts | 10 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/no-activity-hold-sentinel-parity.test.ts | 5 | 0 | 4 | 0/0/0 |  | keep | no signal against it |
| unit/no-motion-parity.test.ts | 5 | 0 | 1 | 0/0/0 | activity-marks | keep | named as a rule enforcement |
| unit/node-modules-link.test.ts | 11 | 0 | 5 | 0/0/0 |  | keep | no signal against it |
| unit/node-pty-version-pin.test.ts | 2 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/notify-adapters-worktree-removed.test.ts | 7 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/notify-conversation-expired.test.ts | 8 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/notify-spawn-blocked.test.ts | 18 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/notify-spawn-warning.test.ts | 10 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/npm-shim-target.test.ts | 26 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/nsis-acl-grant.test.ts | 5 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/nushell-fish-shell-routing.test.ts | 19 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/off-main-cli.test.ts | 4 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/off-main-exec.test.ts | 38 | 0 | 4 | 0/0/0 | pty-host-out-of-process | keep | named as a rule enforcement |
| unit/off-main-pty.test.ts | 1 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/okf-docs-conformance.test.ts | 14 | 0 | 4 | 0/1/0 | docs-stay-in-sync | keep | named as a rule enforcement |
| unit/ollama-adapter.test.ts | 56 | 0 | 4 | 0/0/0 |  | keep | no signal against it |
| unit/on-idle.test.ts | 2 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/onboarding-progress.test.ts | 35 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/open-path-bounded-boundary.test.ts | 2 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/open-task-conversation.test.ts | 15 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/open-task-from-notification.test.ts | 7 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/open-work-ledger.test.ts | 14 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/opencode-adapter-wiring.test.ts | 4 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/opencode-adapter.test.ts | 74 | 0 | 11 | 0/0/0 |  | keep | no signal against it |
| unit/opencode-answer-stream.test.ts | 7 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/opencode-capability-discovery.test.ts | 4 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/opencode-command-injection-query-bound.test.ts | 2 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/opencode-hook-manager.test.ts | 22 | 0 | 4 | 0/0/0 |  | keep | no signal against it |
| unit/opencode-plugin.test.ts | 28 | 0 | 5 | 0/0/0 |  | keep | no signal against it |
| unit/opencode-project-relocation.test.ts | 5 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/opencode-remote-execution.test.ts | 40 | 0 | 6 | 0/0/0 |  | keep | no signal against it |
| unit/opencode-session-delete.test.ts | 11 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/opencode-session-history-parser.live.test.ts | 8 | 0 | 3 | 0/0/0 |  | moved | needs local data; belongs in tests/integration |
| unit/opencode-transcript-parser.test.ts | 11 | 0 | 5 | 0/0/0 |  | keep | no signal against it |
| unit/opencode-wsl.test.ts | 12 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/opt-out-marker.test.ts | 35 | 0 | 6 | 0/0/0 |  | keep | no signal against it |
| unit/output-peek.test.ts | 24 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/overlay-exit-fallback-deadline.test.ts | 4 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/overlay-gate.test.ts | 8 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/overseer-mascot-frames.test.ts | 5 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/own-call-turn-wait.test.ts | 9 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/own-call-wiring.test.ts | 12 | 0 | 2 | 0/0/0 |  | rewritten | pins one importable file's text |
| unit/package-smoke.test.ts | 15 | 0 | 4 | 0/0/0 | pty-host-out-of-process | keep | named as a rule enforcement |
| unit/panel-error-boundary.test.ts | 15 | 0 | 6 | 0/0/0 |  | keep | no signal against it |
| unit/panel-sessions.test.ts | 14 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/parked-terminals.test.ts | 6 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/paste-engine.test.ts | 40 | 0 | 9 | 0/0/0 |  | keep | no signal against it |
| unit/pasted-attachment-naming.test.ts | 11 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/patch-mac-update-info.test.ts | 19 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/paused-for-memory.test.ts | 19 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/pcm-conversion.test.ts | 12 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/per-tool-stats.test.ts | 12 | 0 | 4 | 0/0/0 |  | keep | no signal against it |
| unit/permission-mode-guard.test.ts | 19 | 0 | 4 | 0/0/0 |  | removed | asserts its own copy, which contradicts task-move.ts |
| unit/permission-policy.test.ts | 6 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/pill-provenance.test.ts | 8 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/pill-text-trim.test.ts | 5 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/pixel-diff-canvas.test.ts | 12 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/placeholder-title.test.ts | 5 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/plan-approval-automations-disabled.test.ts | 3 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/plan-approval-board-config.test.ts | 10 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/plan-approval-decision.test.ts | 14 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/plan-approval-gate-confirmation.test.ts | 14 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/plan-approval-gate.test.ts | 44 | 0 | 4 | 0/0/0 |  | keep | no signal against it |
| unit/plan-approval-handlers.test.ts | 9 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/plan-approval-hook-cleanup.test.ts | 9 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/plan-approval-refresh-triggers.test.ts | 12 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/plan-approval-spawn-wiring.test.ts | 18 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/plan-approval-update-task.test.ts | 8 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/plan-approval-writer-fallbacks.test.ts | 28 | 0 | 4 | 0/0/0 |  | keep | no signal against it |
| unit/plan-approval-writer.test.ts | 14 | 0 | 4 | 0/0/0 |  | keep | no signal against it |
| unit/plan-exit-approval-gate.test.ts | 2 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/plan-exit-captured-payloads.test.ts | 3 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/plan-exit-continuation-prompt.test.ts | 3 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/plan-exit-target.test.ts | 11 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/plan-mode-trail.test.ts | 15 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/pop-out-button.test.ts | 5 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/pop-out-cascade.test.ts | 8 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/pop-out-changed.test.ts | 17 | 0 | 2 | 0/0/0 | command-terminal pop-out-surface-registry | keep | named as a rule enforcement |
| unit/pop-out-changes-root-guard.test.ts | 7 | 0 | 4 | 0/0/0 |  | keep | no signal against it |
| unit/pop-out-read-descriptor.test.ts | 17 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/pop-out-store.test.ts | 3 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/pop-out-surface-registry.test.ts | 5 | 0 | 5 | 0/0/0 | pop-out-surface-registry | keep | named as a rule enforcement |
| unit/pop-out-window-manager.test.ts | 35 | 0 | 6 | 0/0/0 | command-terminal pop-out-surface-registry | keep | named as a rule enforcement |
| unit/pop-out.test.ts | 47 | 0 | 9 | 0/0/0 | command-terminal pop-out-surface-registry | keep | named as a rule enforcement |
| unit/popover-inflow-menu.test.ts | 12 | 0 | 6 | 0/0/1 | popover-escapes-clipping | keep | named as a rule enforcement |
| unit/pr-command-detector.test.ts | 10 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/pr-dispatch.test.ts | 19 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/pr-identity.test.ts | 14 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/pr-link-degrade-hint-eviction.test.ts | 1 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/pr-link-degrade-hints.test.ts | 1 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/pr-link-ladder.test.ts | 145 | 0 | 24 | 0/0/0 |  | keep | no signal against it |
| unit/pr-merge-readiness-migration.test.ts | 3 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/pr-refresh-scheduler.test.ts | 17 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/pr-refresh-sweep.test.ts | 11 | 0 | 5 | 0/0/0 |  | keep | no signal against it |
| unit/pr-remote-gate-no-wipe.test.ts | 5 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/pr-state.test.ts | 42 | 0 | 4 | 0/0/0 |  | keep | no signal against it |
| unit/pr-url.test.ts | 9 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/preload-track-renderer-error-context.test.ts | 1 | 0 | 1 | 0/0/0 |  | rewritten | pins one importable file's text |
| unit/preload-web-apis-only.test.ts | 2 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/prepare-agent-spawn.test.ts | 28 | 0 | 17 | 0/0/0 | task-process-tag | keep | named as a rule enforcement |
| unit/prepare-spawn-cli-target-wiring.test.ts | 3 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/prepare-spawn-first-spawn-lock.test.ts | 8 | 0 | 4 | 0/0/0 |  | keep | no signal against it |
| unit/prepare-spawn-resume-conversation-guard.test.ts | 14 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/prepare-spawn-resume-reconcile.test.ts | 5 | 0 | 4 | 0/0/0 |  | keep | no signal against it |
| unit/prepare-spawn-shim-launch-wiring.test.ts | 4 | 0 | 1 | 0/0/0 | spawn-entry-point-parity | keep | named as a rule enforcement |
| unit/preview-bridge.test.ts | 14 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/preview-cheap-model-override.test.ts | 6 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/preview-clone-fill-marker.test.ts | 4 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/preview-exit-classification.test.ts | 25 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/preview-isolation-own-pid.test.ts | 3 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/preview-task-title.test.ts | 12 | 0 | 6 | 0/0/0 |  | keep | no signal against it |
| unit/preview-team-config-checkout.test.ts | 3 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/priority-labels.test.ts | 9 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/process-kill-sites.test.ts | 5 | 0 | 1 | 0/0/0 | task-process-tag | keep | named as a rule enforcement |
| unit/process-label.test.ts | 24 | 0 | 1 | 0/0/0 | task-process-tag | keep | named as a rule enforcement |
| unit/process-liveness.test.ts | 4 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/process-metrics.test.ts | 3 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/process-tree-protocol.test.ts | 4 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/process-tree.test.ts | 45 | 0 | 4 | 0/0/0 |  | keep | no signal against it |
| unit/progress-color.test.ts | 8 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/project-agent-defaults-inheritance.test.ts | 8 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/project-cache.test.ts | 23 | 0 | 8 | 0/0/0 |  | keep | no signal against it |
| unit/project-delete-clears-conversation-expired.test.ts | 3 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/project-delete-removed-worktrees.test.ts | 5 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/project-delete-task-windows.test.ts | 5 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/project-entry-search-tree-kill.test.ts | 5 | 0 | 1 | 0/0/0 | task-process-tag | keep | named as a rule enforcement |
| unit/project-entry-search.test.ts | 7 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/project-list-degradation.test.ts | 7 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/project-log-context.test.ts | 7 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/project-model-defaults-cross-agent.test.ts | 10 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/project-open-outcomes.test.ts | 10 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/project-open-warnings-push.test.ts | 3 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/project-probe-cache.test.ts | 5 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/project-probe-path-handler.test.ts | 9 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/project-relocate.test.ts | 40 | 0 | 8 | 0/0/0 |  | keep | no signal against it |
| unit/project-scoped-ipc.test.ts | 4 | 0 | 21 | 0/0/0 | project-scoped-ipc | keep | named as a rule enforcement |
| unit/project-scoped-read-handlers.test.ts | 4 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/project-store-default-writes.test.ts | 15 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/project-store-load-degradation.test.ts | 9 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/projection-math.test.ts | 7 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/promote-own-record.test.ts | 2 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/prompt-budget.test.ts | 12 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/prompt-draft-ledger.test.ts | 13 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/prompt-tags.test.ts | 8 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/prompt-xml.test.ts | 31 | 0 | 9 | 0/0/0 |  | keep | no signal against it |
| unit/protocol/base64url.test.ts | 2 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/protocol/board-column-role-parity.test.ts | 1 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/protocol/capabilities.test.ts | 9 | 0 | 5 | 0/0/0 |  | keep | no signal against it |
| unit/protocol/event-payloads.test.ts | 106 | 0 | 25 | 0/0/0 |  | keep | no signal against it |
| unit/protocol/fingerprint.test.ts | 6 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/protocol/noise-kk-session.test.ts | 3 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/protocol/noise-pairing.test.ts | 6 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/protocol/noise-vectors.test.ts | 3 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/protocol/pairing-confirm.test.ts | 7 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/protocol/payloads.test.ts | 56 | 0 | 10 | 0/0/0 |  | keep | no signal against it |
| unit/protocol/push-clear.test.ts | 15 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/protocol/push-envelope.test.ts | 25 | 0 | 6 | 0/0/0 |  | keep | no signal against it |
| unit/protocol/qr.test.ts | 6 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/protocol/relay-address.test.ts | 8 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/protocol/roster.test.ts | 7 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/protocol/sas.test.ts | 5 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/protocol/secretstream.test.ts | 7 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/protocol/session-frame.test.ts | 5 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/protocol/slot.test.ts | 10 | 0 | 2 | 0/0/0 | command-terminal | keep | named as a rule enforcement |
| unit/protocol/task-report.test.ts | 26 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/prune-profile-references.test.ts | 12 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/prune-stale-worktrees.test.ts | 9 | 0 | 13 | 0/0/0 |  | keep | no signal against it |
| unit/pty-activity-tracker.test.ts | 15 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/pty-exit-callback-drain.test.ts | 17 | 0 | 3 | 0/0/0 | pty-teardown-grace synchronous-shutdown | keep | named as a rule enforcement |
| unit/pty-host-client-seed-frame.test.ts | 3 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/pty-host-lost-tree-stop.test.ts | 3 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/pty-host-spawn-worker.test.ts | 33 | 0 | 2 | 0/0/0 | pty-host-out-of-process | keep | named as a rule enforcement |
| unit/pty-port-client.test.ts | 10 | 0 | 2 | 0/0/0 | pty-host-out-of-process | keep | named as a rule enforcement |
| unit/pty-resize-echo-reassert.test.ts | 26 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/pty-spawn.test.ts | 71 | 0 | 14 | 0/0/0 |  | keep | no signal against it |
| unit/pty-teardown-grace.test.ts | 5 | 0 | 5 | 0/0/0 | pty-teardown-grace | keep | named as a rule enforcement |
| unit/push-command-detector.test.ts | 14 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/push-command.test.ts | 81 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/pushed-branch-cleanup-parity.test.ts | 6 | 0 | 5 | 0/0/1 |  | keep | red with a product change in the window |
| unit/query-vectors.test.ts | 3 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/queue-snapshot.test.ts | 17 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/queued-resume-settle.test.ts | 11 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/qwen-adapter-mcp-version.test.ts | 10 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/qwen-adapter.test.ts | 32 | 0 | 6 | 0/0/0 |  | keep | no signal against it |
| unit/qwen-capability-discovery.test.ts | 6 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/qwen-command-builder.test.ts | 67 | 0 | 12 | 0/0/0 |  | keep | no signal against it |
| unit/qwen-command-injection-verifier.test.ts | 10 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/qwen-detector.test.ts | 5 | 0 | 1 | 0/0/0 |  | table | 0 of 315 kills on agent-detector.ts are theirs; keep each parser as a row |
| unit/qwen-home.test.ts | 4 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/qwen-hook-manager.test.ts | 18 | 0 | 7 | 0/0/0 |  | keep | no signal against it |
| unit/qwen-integration.test.ts | 25 | 0 | 8 | 0/0/0 |  | keep | no signal against it |
| unit/qwen-live-smoke.test.ts | 2 | 0 | 2 | 0/0/0 |  | moved | needs a live CLI; belongs in tests/integration |
| unit/qwen-project-relocation.test.ts | 12 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/qwen-status-parser.test.ts | 4 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/qwen-transcript-cleanup.test.ts | 17 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/qwen-transcript-parser.test.ts | 10 | 0 | 5 | 0/0/0 |  | keep | no signal against it |
| unit/qwen-trust-manager.test.ts | 29 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/qwen-wsl.test.ts | 6 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/rate-limit-ledger.test.ts | 18 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/rate-limit-window.test.ts | 47 | 0 | 4 | 0/0/0 |  | keep | no signal against it |
| unit/readable-text.test.ts | 4 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/readme-translations.test.ts | 45 | 0 | 2 | 0/0/0 | i18n | keep | named as a rule enforcement |
| unit/recap-turns.test.ts | 34 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/redact-event-paths.test.ts | 30 | 0 | 4 | 0/0/0 |  | keep | no signal against it |
| unit/refuse-done-clause-wiring.test.ts | 6 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/related-rank-prior-work.test.ts | 10 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/related-work-across.test.ts | 15 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/related-work-prior-work.test.ts | 14 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/related-work.test.ts | 39 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/relay-url.test.ts | 52 | 0 | 4 | 0/0/0 |  | keep | no signal against it |
| unit/release-asset-manifest.test.ts | 15 | 0 | 2 | 0/0/0 | release-gates-fail-loudly | keep | named as a rule enforcement |
| unit/release-workflow-gates.test.ts | 77 | 0 | 12 | 0/0/0 | release-gates-fail-loudly | keep | named as a rule enforcement |
| unit/relocation-utils.test.ts | 15 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/remote-cli-process.test.ts | 8 | 0 | 1 | 0/0/0 | pty-host-out-of-process | keep | named as a rule enforcement |
| unit/remote-item-cache-repository.test.ts | 16 | 0 | 6 | 0/0/0 |  | keep | no signal against it |
| unit/remote-openai-engine.test.ts | 11 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/remote-pty-seal.test.ts | 5 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/remove-worktree.test.ts | 27 | 0 | 14 | 0/0/0 |  | keep | no signal against it |
| unit/removed-worktrees-drain.test.ts | 11 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/renderer-classification.test.ts | 11 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/renderer-optimize-deps-parity.test.ts | 8 | 0 | 5 | 0/0/0 |  | keep | no signal against it |
| unit/renderer-recharts-lazy.test.ts | 4 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/renderer-recovery.test.ts | 11 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/renderer-store-import-cycles.test.ts | 2 | 0 | 2 | 0/0/0 | hmr-patterns | keep | named as a rule enforcement |
| unit/repaint-nudge.test.ts | 89 | 0 | 6 | 0/0/0 |  | keep | no signal against it |
| unit/repair-lockfile-integrity.test.ts | 28 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/replay-width-invariant.test.ts | 10 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/repo-hygiene.test.ts | 12 | 0 | 6 | 0/1/0 |  | keep | no signal against it |
| unit/reportable-module-name.test.ts | 50 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/resize-manager.test.ts | 11 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/resolve-effective-permission-mode.test.ts | 7 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/resolve-project-context.test.ts | 8 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/resolve-spawn-overrides.test.ts | 28 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/resolve-terminal-background.test.ts | 5 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/resolve-terminal-foreground.test.ts | 5 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/resolve-theme.test.ts | 4 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/resource-cleanup.test.ts | 46 | 0 | 20 | 0/0/0 |  | keep | no signal against it |
| unit/restart-session-for-settings-change.test.ts | 11 | 0 | 12 | 0/0/0 |  | keep | no signal against it |
| unit/restore-lane-order.test.ts | 20 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/restore-no-animation-replay.test.ts | 5 | 0 | 3 | 0/0/0 | restore-no-animation-replay | keep | named as a rule enforcement |
| unit/resume-conversation-guard-branches.test.ts | 17 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/resume-conversation-guard.test.ts | 41 | 0 | 7 | 0/0/0 |  | keep | no signal against it |
| unit/resume-cwd-migration.test.ts | 13 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/resume-id-reconcile.test.ts | 42 | 0 | 6 | 0/0/0 |  | keep | no signal against it |
| unit/resume-prompt-delivery-parity.test.ts | 31 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/resume-prompt-delivery.test.ts | 32 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/resume-suspended-expired-recap.test.ts | 12 | 0 | 4 | 0/0/0 |  | keep | no signal against it |
| unit/resume-suspended-placeholder.test.ts | 31 | 0 | 6 | 0/0/0 |  | keep | no signal against it |
| unit/resume-suspended-profile-scoped.test.ts | 19 | 0 | 11 | 0/0/0 |  | keep | no signal against it |
| unit/resync-board-after-monitor-write.test.ts | 4 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/retrieval-checkpoint-pacing.test.ts | 3 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/retrieval-client.test.ts | 24 | 0 | 4 | 0/0/0 |  | keep | no signal against it |
| unit/retrieval-crash-report.test.ts | 2 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/retrieval-fts-query.test.ts | 27 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/retrieval-fusion.test.ts | 9 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/retrieval-index-methods.test.ts | 7 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/retrieval-queries-command-terminal.test.ts | 3 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/retrieval-queries.test.ts | 10 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/retrieval-service-status.test.ts | 6 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/retrieval-token-estimate.test.ts | 6 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/retrieval-worker-command-terminal.test.ts | 6 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/retrieval-worker-methods.test.ts | 4 | 0 | 5 | 0/0/0 |  | keep | no signal against it |
| unit/retry-failed-done-cleanups.test.ts | 10 | 0 | 8 | 0/0/0 |  | keep | no signal against it |
| unit/return-recap.test.ts | 47 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/review-eval-cli.test.ts | 10 | 0 | 3 | 0/0/0 |  | removed | tested a one-off harness; went with scripts/review-eval |
| unit/review-eval-decide.test.ts | 32 | 0 | 4 | 0/0/0 |  | removed | tested a one-off harness; went with scripts/review-eval |
| unit/review-eval-replay.test.ts | 23 | 0 | 3 | 0/0/0 |  | removed | tested a one-off harness; went with scripts/review-eval |
| unit/review-eval-tally.test.ts | 17 | 0 | 3 | 0/0/0 |  | removed | tested a one-off harness; went with scripts/review-eval |
| unit/review-eval-transcripts.test.ts | 34 | 0 | 2 | 0/0/0 |  | removed | tested a one-off harness; went with scripts/review-eval |
| unit/review-verdict.test.ts | 63 | 0 | 6 | 0/0/0 |  | keep | no signal against it |
| unit/rm-with-retry.test.ts | 10 | 0 | 5 | 0/0/0 |  | keep | no signal against it |
| unit/root-pid-gate.test.ts | 18 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/round-trip-input.test.ts | 2 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/rules-index-parity.test.ts | 9 | 0 | 4 | 0/0/0 | AGENTS | keep | named as a rule enforcement |
| unit/run-cli-print-summarize.test.ts | 41 | 0 | 4 | 0/0/0 |  | keep | no signal against it |
| unit/run-init-script-tree-kill.test.ts | 1 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/run-init-script.test.ts | 18 | 0 | 6 | 0/0/0 |  | keep | no signal against it |
| unit/run-script-adapter-tree-kill.test.ts | 5 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/safe-write-cleanup-failure.test.ts | 3 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/safe-write.test.ts | 12 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/sanitize-error-message.test.ts | 5 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/scene-url.test.ts | 5 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/scroll-latency-report.test.ts | 18 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/scrollback-slice.test.ts | 13 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/scrollbar-math.test.ts | 17 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/search-everything-core.test.ts | 21 | 0 | 7 | 0/0/0 |  | keep | no signal against it |
| unit/search-everything-ipc.test.ts | 5 | 0 | 4 | 0/0/0 |  | keep | no signal against it |
| unit/search-everything-mcp.test.ts | 91 | 0 | 4 | 0/0/0 |  | keep | no signal against it |
| unit/search-tasks-scope.test.ts | 28 | 0 | 9 | 0/0/0 |  | keep | no signal against it |
| unit/seed-knowledge-graph-demo-ipc.test.ts | 6 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/seed-knowledge-graph-demo.test.ts | 28 | 0 | 5 | 0/0/0 |  | keep | no signal against it |
| unit/select-active-session.test.ts | 18 | 0 | 4 | 0/0/0 |  | keep | no signal against it |
| unit/send-message-adapter.test.ts | 4 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/send-to-backlog-confirm.test.ts | 8 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/sentry-breadcrumbs.test.ts | 73 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/sentry-guest-crash-contract.test.ts | 33 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/session-auto-resume-on-restart.test.ts | 3 | 0 | 10 | 0/0/0 |  | keep | no signal against it |
| unit/session-auto-resume-orphan-upgrade.test.ts | 5 | 0 | 7 | 0/0/0 |  | keep | no signal against it |
| unit/session-branch-pushed-record.test.ts | 6 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/session-cli-target-column.test.ts | 9 | 0 | 4 | 0/0/0 |  | keep | no signal against it |
| unit/session-display-state.test.ts | 32 | 0 | 11 | 0/0/0 | session-replica-contract | keep | named as a rule enforcement |
| unit/session-exit-git-churn-wiring.test.ts | 3 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/session-exit-intentional.test.ts | 7 | 0 | 11 | 0/0/0 |  | keep | no signal against it |
| unit/session-exit-startup-failure-notice.test.ts | 8 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/session-file-manager.test.ts | 8 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/session-files-commands.test.ts | 16 | 0 | 6 | 0/0/0 |  | keep | no signal against it |
| unit/session-history-reader-cursor-branches.test.ts | 4 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/session-history-reader.test.ts | 21 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/session-id-manager.test.ts | 26 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/session-id-scanner.test.ts | 9 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/session-idle-pr-link.test.ts | 7 | 0 | 5 | 0/0/0 |  | keep | no signal against it |
| unit/session-idle-timeout.test.ts | 14 | 0 | 18 | 0/0/0 | command-terminal | keep | named as a rule enforcement |
| unit/session-index-eviction.test.ts | 16 | 0 | 3 | 0/0/0 | session-replica-contract | keep | named as a rule enforcement |
| unit/session-inject-settings-handler.test.ts | 10 | 0 | 5 | 0/0/0 |  | keep | no signal against it |
| unit/session-interrupted-exited-sql.test.ts | 5 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/session-isolation.test.ts | 8 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/session-kill-followup.test.ts | 4 | 0 | 2 | 0/0/0 | session-replica-contract | keep | named as a rule enforcement |
| unit/session-lifecycle-hooks.test.ts | 2 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/session-lifecycle-lane-cleanup.test.ts | 6 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/session-lifecycle-retire-record.test.ts | 3 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/session-lifecycle-suspend-orphaned.test.ts | 2 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/session-manager-activity-reason-emit.test.ts | 1 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/session-manager-activity-reasons-cache.test.ts | 6 | 0 | 4 | 0/0/0 |  | keep | no signal against it |
| unit/session-manager-agent-absence.test.ts | 48 | 0 | 9 | 0/0/0 | command-terminal | keep | named as a rule enforcement |
| unit/session-manager-announce-ended.test.ts | 5 | 0 | 1 | 0/0/0 | session-replica-contract | keep | named as a rule enforcement |
| unit/session-manager-branch-pushed-wiring.test.ts | 1 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/session-manager-command-terminal-branch.test.ts | 5 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/session-manager-command-terminal-label.test.ts | 14 | 0 | 3 | 0/0/0 | command-terminal | keep | named as a rule enforcement |
| unit/session-manager-deferred-kill.test.ts | 33 | 0 | 7 | 0/0/0 | pty-teardown-grace | keep | named as a rule enforcement |
| unit/session-manager-earlier-runs.test.ts | 6 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/session-manager-end-command-terminal.test.ts | 14 | 0 | 4 | 0/0/0 | command-terminal | keep | named as a rule enforcement |
| unit/session-manager-first-reported-effort.test.ts | 3 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/session-manager-hidden-spawn.test.ts | 10 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/session-manager-history-pty-fallback.test.ts | 10 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/session-manager-host-lifecycle.test.ts | 12 | 0 | 4 | 0/0/0 |  | keep | no signal against it |
| unit/session-manager-idle-suspend-wiring.test.ts | 7 | 0 | 2 | 0/0/0 | command-terminal | keep | named as a rule enforcement |
| unit/session-manager-input-ready.test.ts | 5 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/session-manager-kill-reap-wait.test.ts | 4 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/session-manager-mark-background-services.test.ts | 5 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/session-manager-placeholder-emit.test.ts | 9 | 0 | 8 | 0/0/0 | session-replica-contract | keep | named as a rule enforcement |
| unit/session-manager-plan-approval-lookup.test.ts | 9 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/session-manager-plan-mode-wiring.test.ts | 3 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/session-manager-prompt-draft-wiring.test.ts | 9 | 0 | 4 | 0/0/0 |  | keep | no signal against it |
| unit/session-manager-remove-emit.test.ts | 7 | 0 | 2 | 0/0/0 | session-replica-contract | keep | named as a rule enforcement |
| unit/session-manager-report-rejected-permission-tools.test.ts | 6 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/session-manager-report-terminated-shells.test.ts | 6 | 0 | 4 | 0/0/0 |  | keep | no signal against it |
| unit/session-manager-reported-processes.test.ts | 18 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/session-manager-resumed-event.test.ts | 4 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/session-manager-spawn-cancel.test.ts | 35 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/session-manager-transient-earlier-runs.test.ts | 3 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/session-manager-turn-anchor.test.ts | 36 | 0 | 5 | 0/0/0 |  | keep | no signal against it |
| unit/session-manager-user-input.test.ts | 16 | 0 | 3 | 0/0/0 | command-terminal | keep | named as a rule enforcement |
| unit/session-manager-write-queue.test.ts | 9 | 0 | 8 | 0/0/0 |  | keep | no signal against it |
| unit/session-manager-wsl-usage.test.ts | 7 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/session-metrics-history.test.ts | 15 | 0 | 5 | 0/0/0 |  | keep | no signal against it |
| unit/session-metrics-refine-tokens.test.ts | 5 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/session-metrics-refine-tool-counts.test.ts | 9 | 0 | 4 | 0/0/0 |  | keep | no signal against it |
| unit/session-metrics-tool-result-tokens.test.ts | 5 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/session-own-record.test.ts | 6 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/session-pause-options.test.ts | 6 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/session-plan-exit-workflow-route.test.ts | 2 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/session-pty-grid-migration.test.ts | 3 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/session-pty-grid-persistence.test.ts | 26 | 0 | 5 | 0/0/0 |  | keep | no signal against it |
| unit/session-queue-push.test.ts | 11 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/session-queue.test.ts | 17 | 0 | 4 | 0/0/0 |  | keep | no signal against it |
| unit/session-queued-status.test.ts | 10 | 0 | 9 | 0/0/0 |  | keep | no signal against it |
| unit/session-reap-parked-exit.test.ts | 7 | 0 | 4 | 0/0/0 | pty-teardown-grace | keep | named as a rule enforcement |
| unit/session-reconcile-git-churn-wiring.test.ts | 4 | 0 | 6 | 0/0/0 |  | keep | no signal against it |
| unit/session-reconcile-helpers.test.ts | 11 | 0 | 8 | 0/0/0 |  | keep | no signal against it |
| unit/session-reconcile-unsent-prompt.test.ts | 5 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/session-recovery-isolation.test.ts | 8 | 0 | 10 | 0/0/0 |  | keep | no signal against it |
| unit/session-registry.test.ts | 33 | 0 | 7 | 0/0/0 |  | keep | no signal against it |
| unit/session-removed-forwarding.test.ts | 9 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/session-repository-agent-session-id.test.ts | 8 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/session-repository-applied-settings.test.ts | 7 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/session-repository-find-by-any-id.test.ts | 4 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/session-repository-interrupted-exited.test.ts | 4 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/session-repository-isolated-since.test.ts | 3 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/session-repository-list-for-task.test.ts | 2 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/session-repository-metrics.test.ts | 33 | 0 | 11 | 0/0/0 |  | keep | no signal against it |
| unit/session-repository-orphan.test.ts | 4 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/session-repository-stop-eligible.test.ts | 5 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/session-repository-task-report-reads.test.ts | 9 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/session-respawn.test.ts | 12 | 0 | 12 | 0/0/0 |  | keep | no signal against it |
| unit/session-result-tokens-read-migration.test.ts | 3 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/session-resume-after-entry.test.ts | 20 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/session-resume-before-lock.test.ts | 9 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/session-resume-controllers.test.ts | 4 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/session-resume-guard.test.ts | 55 | 0 | 17 | 0/0/0 |  | keep | no signal against it |
| unit/session-resume-held-messages.test.ts | 5 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/session-resume-os-killed.test.ts | 29 | 0 | 10 | 0/0/0 |  | keep | no signal against it |
| unit/session-resume-reconcile.test.ts | 11 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/session-shutdown-exit-suspend.test.ts | 7 | 0 | 9 | 0/0/0 |  | keep | no signal against it |
| unit/session-shutdown-flow.test.ts | 28 | 0 | 9 | 0/0/0 | pty-teardown-grace synchronous-shutdown | keep | named as a rule enforcement |
| unit/session-spawn-analytics.test.ts | 17 | 0 | 16 | 0/0/0 |  | keep | no signal against it |
| unit/session-spawn-flow.test.ts | 88 | 0 | 37 | 0/0/0 | command-terminal pty-teardown-grace session-replica-contract task-process-tag | keep | named as a rule enforcement |
| unit/session-start-hook.test.ts | 23 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/session-start.test.ts | 21 | 0 | 11 | 0/0/0 |  | keep | no signal against it |
| unit/session-store-cache-reconcile.test.ts | 39 | 0 | 8 | 0/0/0 |  | keep | no signal against it |
| unit/session-store-conversation-request.test.ts | 10 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/session-store-detail-view-hydration.test.ts | 34 | 0 | 7 | 0/0/0 |  | keep | no signal against it |
| unit/session-store-hmr.test.ts | 2 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/session-store-rate-limits.test.ts | 30 | 0 | 9 | 0/0/0 |  | keep | no signal against it |
| unit/session-store-remove-session.test.ts | 12 | 0 | 2 | 0/0/0 | session-replica-contract | keep | named as a rule enforcement |
| unit/session-store-seen-idle.test.ts | 9 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/session-store-spawn-progress-suspended-preserve.test.ts | 5 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/session-store-task-row-dedup.test.ts | 5 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/session-suspend-flow.test.ts | 13 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/session-telemetry-absence-check.test.ts | 4 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/session-telemetry-activity-decisions.test.ts | 36 | 0 | 11 | 0/0/0 | command-terminal | keep | named as a rule enforcement |
| unit/session-telemetry-activity-reasons.test.ts | 9 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/session-telemetry-agent-session-id-gate.test.ts | 10 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/session-telemetry-branch-pushed.test.ts | 4 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/session-telemetry-conversation-switch.test.ts | 22 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/session-telemetry-first-reported-effort.test.ts | 4 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/session-telemetry-internal-agent-tools.test.ts | 12 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/session-telemetry-permission-rejection-poll.test.ts | 13 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/session-telemetry-rate-limit-reset.test.ts | 3 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/session-telemetry-reported-transcript-path.test.ts | 6 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/session-telemetry-tool-count-stamp.test.ts | 14 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/session-telemetry-wiring.test.ts | 21 | 0 | 14 | 0/0/0 | command-terminal | keep | named as a rule enforcement |
| unit/session-toggle.test.ts | 50 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/session-tool-breakdown-ipc-wiring.test.ts | 3 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/session-track.test.ts | 4 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/session-transcript-path-wiring.test.ts | 3 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/session-transcript-path.test.ts | 8 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/session-update-coalescer-reload-gate.test.ts | 15 | 0 | 4 | 0/0/0 |  | keep | no signal against it |
| unit/session-usage-event-focus-buffering.test.ts | 6 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/session-wsl-reap-live-task.test.ts | 11 | 0 | 5 | 0/0/0 | task-process-tag | keep | named as a rule enforcement |
| unit/sessions-port-broker.test.ts | 15 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/settings-card-design.test.ts | 11 | 0 | 8 | 0/0/0 | settings-card-design ui-conventions | keep | named as a rule enforcement |
| unit/settings-search.test.ts | 31 | 0 | 8 | 0/0/0 |  | keep | no signal against it |
| unit/settings-snapshot.test.ts | 21 | 0 | 5 | 0/0/0 |  | keep | no signal against it |
| unit/settings-tab-scope-parity.test.ts | 19 | 0 | 6 | 0/0/0 | settings-tab-scope AGENTS | keep | named as a rule enforcement |
| unit/settings-target-project.test.ts | 7 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/settle-scroll.test.ts | 10 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/shared-folder-holds.test.ts | 11 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/shared-type-source.test.ts | 6 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/shell-env.test.ts | 29 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/shell-exec-handler.test.ts | 7 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/shell-launch-parity.test.ts | 6 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/shell-launch.test.ts | 11 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/shell-open-external-handler.test.ts | 9 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/shell-open-path-handler.test.ts | 8 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/shell-quote.test.ts | 48 | 0 | 5 | 0/0/0 | cross-platform-parity | keep | named as a rule enforcement |
| unit/shell-resolver-cache.test.ts | 4 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/sherpa-engines.test.ts | 17 | 0 | 4 | 0/1/0 |  | keep | no signal against it |
| unit/sherpa-online-engine.test.ts | 15 | 0 | 4 | 0/0/0 |  | keep | no signal against it |
| unit/sherpa-whisper-engine.test.ts | 16 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/shim-launch.test.ts | 48 | 0 | 2 | 0/0/0 | spawn-entry-point-parity task-process-tag | keep | named as a rule enforcement |
| unit/should-show-whats-new.test.ts | 7 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/show-automation-notification.test.ts | 4 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/shutdown-history-wiring.test.ts | 24 | 0 | 17 | 0/0/0 | synchronous-shutdown | keep | named as a rule enforcement |
| unit/shutdown-leak-fixes.test.ts | 5 | 0 | 1 | 0/0/0 | synchronous-shutdown | keep | named as a rule enforcement |
| unit/simple-git-client-dev-attribution.test.ts | 4 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/simple-git-client.test.ts | 6 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/slice-keeping-pairs.test.ts | 16 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/slot-reorder.test.ts | 16 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/source-store.test.ts | 6 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/spare-worktree-eligibility.test.ts | 34 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/spare-worktree-records.test.ts | 90 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/spawn-agent-config-migration.test.ts | 9 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/spawn-agent-continuation-prompt.test.ts | 9 | 0 | 9 | 0/0/1 |  | keep | red with a product change in the window |
| unit/spawn-agent-explicit-start.test.ts | 12 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/spawn-agent-isolated-auto-command.test.ts | 27 | 0 | 13 | 0/0/1 |  | keep | red with a product change in the window |
| unit/spawn-agent-return-recap.test.ts | 24 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/spawn-agent-typed-opening.test.ts | 12 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/spawn-caller.test.ts | 4 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/spawn-cli-off-main.test.ts | 9 | 0 | 5 | 0/0/0 | pty-host-out-of-process | keep | named as a rule enforcement |
| unit/spawn-failure-handler.test.ts | 5 | 0 | 2 | 0/0/0 | session-replica-contract | keep | named as a rule enforcement |
| unit/spawn-helper-permissions.test.ts | 6 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/spawn-helper-upstream-parity.test.ts | 5 | 0 | 2 | 0/0/0 | pty-host-out-of-process | keep | named as a rule enforcement |
| unit/spawn-intent.test.ts | 26 | 0 | 10 | 0/0/0 |  | keep | no signal against it |
| unit/spawn-progress.test.ts | 47 | 0 | 14 | 0/0/0 |  | keep | no signal against it |
| unit/spawn-with-abort-binary.test.ts | 4 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/spawn-with-abort-off-main.test.ts | 9 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/spawn-with-abort.test.ts | 10 | 0 | 4 | 0/0/0 | task-process-tag | keep | named as a rule enforcement |
| unit/spawnable.test.ts | 66 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/split-lock-cas.test.ts | 24 | 0 | 28 | 0/0/0 |  | keep | no signal against it |
| unit/sqlite-error.test.ts | 11 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/stall-profiler.test.ts | 5 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/startup-gate.test.ts | 37 | 0 | 9 | 0/0/0 |  | keep | no signal against it |
| unit/startup-timing.test.ts | 4 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/stats-dashboard-warm-once-guard.test.ts | 2 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/stats-date-locale.test.ts | 5 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/status-file-reader.test.ts | 29 | 0 | 10 | 0/0/0 |  | keep | no signal against it |
| unit/stderr-tail.test.ts | 46 | 0 | 8 | 0/0/0 | cross-platform-parity dictation-out-of-process retrieval-out-of-process | keep | named as a rule enforcement |
| unit/stop-script-failure.test.ts | 4 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/stop-script-toast-body.test.ts | 8 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/strategy-propagation.test.ts | 27 | 0 | 9 | 0/0/0 |  | keep | no signal against it |
| unit/structural-sharing.test.ts | 26 | 0 | 14 | 0/0/0 |  | keep | no signal against it |
| unit/structured-transcript-saved-fallback.test.ts | 7 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/subagent-usage-parser.test.ts | 19 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/summarize-rate-limit.test.ts | 14 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/summary-real-replies.test.ts | 10 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/summary-scheduler-call-backoff.test.ts | 4 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/swimlane-icons.test.ts | 45 | 0 | 3 | 0/0/0 | ui-conventions | keep | named as a rule enforcement |
| unit/swimlane-max-agents.test.ts | 7 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/swimlane-repository.test.ts | 8 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/swimlane-role-normalization.test.ts | 22 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/swimlane-slice.test.ts | 5 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/tab-focus.test.ts | 10 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/task-archive-handler.test.ts | 41 | 0 | 21 | 0/0/0 |  | keep | no signal against it |
| unit/task-card-resting-transform.test.ts | 3 | 0 | 1 | 0/0/0 |  | rewritten | pins one importable file's text |
| unit/task-changes-panel-slice.test.ts | 57 | 0 | 14 | 0/0/0 |  | keep | no signal against it |
| unit/task-cleanup-live-guard.test.ts | 4 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/task-commands-run-mode.test.ts | 6 | 0 | 4 | 0/0/0 |  | keep | no signal against it |
| unit/task-commands-settings-apply.test.ts | 10 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/task-create-handler.test.ts | 22 | 0 | 16 | 0/0/0 |  | keep | no signal against it |
| unit/task-delete-announce.test.ts | 9 | 0 | 4 | 0/0/0 |  | keep | no signal against it |
| unit/task-detail-bundle.test.ts | 6 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/task-detail-host-decoupling.test.ts | 3 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/task-detail-ownership-handlers.test.ts | 6 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/task-detail-view-state-handler.test.ts | 2 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/task-directories.test.ts | 7 | 0 | 1 | 0/0/0 | task-process-tag | keep | named as a rule enforcement |
| unit/task-git-remote-worktree-skip.test.ts | 23 | 0 | 10 | 0/0/0 |  | keep | no signal against it |
| unit/task-knowledge-lines.test.ts | 18 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/task-lifecycle-lock.test.ts | 8 | 0 | 1 | 0/0/0 | task-lifecycle-lock | keep | named as a rule enforcement |
| unit/task-move-clear-archived.test.ts | 7 | 0 | 7 | 0/0/0 |  | keep | no signal against it |
| unit/task-move-complete-analytics.test.ts | 9 | 0 | 13 | 0/0/0 |  | keep | no signal against it |
| unit/task-move-confirm-slice.test.ts | 5 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/task-move-early-agent.test.ts | 9 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/task-move-git-churn-wiring.test.ts | 6 | 0 | 14 | 0/0/0 |  | keep | no signal against it |
| unit/task-move-isolation-switch.test.ts | 9 | 0 | 19 | 0/0/0 |  | keep | no signal against it |
| unit/task-move-message-paste.test.ts | 24 | 0 | 8 | 0/0/0 |  | keep | no signal against it |
| unit/task-move-origin-fanout.test.ts | 31 | 0 | 13 | 0/0/0 |  | keep | no signal against it |
| unit/task-move-origin.test.ts | 10 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/task-move-own-agent-turn-branches.test.ts | 13 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/task-move-own-agent-turn.test.ts | 11 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/task-move-repository.test.ts | 16 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/task-move-respawn-progress-label.test.ts | 15 | 0 | 11 | 0/0/1 |  | keep | red with a product change in the window |
| unit/task-move-rollback.test.ts | 6 | 0 | 14 | 0/0/0 |  | keep | no signal against it |
| unit/task-move-settings-restart.test.ts | 22 | 0 | 23 | 0/0/0 |  | keep | no signal against it |
| unit/task-move-shutdown.test.ts | 18 | 0 | 19 | 0/0/0 | synchronous-shutdown | keep | named as a rule enforcement |
| unit/task-move-stale-branch-cleanup.test.ts | 6 | 0 | 7 | 0/0/0 |  | keep | no signal against it |
| unit/task-move-todo-pr-reset.test.ts | 19 | 0 | 5 | 0/0/0 |  | keep | no signal against it |
| unit/task-ordering.test.ts | 22 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/task-plan-approval.test.ts | 17 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/task-prior-work-handler.test.ts | 24 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/task-process-tag.test.ts | 37 | 0 | 5 | 0/0/0 |  | keep | no signal against it |
| unit/task-profile.test.ts | 7 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/task-reap-failure-report.test.ts | 25 | 0 | 6 | 0/0/0 | task-process-tag | keep | named as a rule enforcement |
| unit/task-reap-plan.test.ts | 109 | 0 | 7 | 0/0/0 | task-process-tag | keep | named as a rule enforcement |
| unit/task-record-index.test.ts | 11 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/task-report-assemble.test.ts | 36 | 0 | 4 | 0/0/0 |  | keep | no signal against it |
| unit/task-report.test.ts | 33 | 0 | 5 | 0/0/0 |  | keep | no signal against it |
| unit/task-repository.test.ts | 36 | 0 | 10 | 0/0/0 |  | keep | no signal against it |
| unit/task-resolve-pr-no-project.test.ts | 7 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/task-resolver.test.ts | 15 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/task-runtime-override-gating.test.ts | 13 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/task-runtime-override-handler.test.ts | 38 | 0 | 12 | 0/0/0 |  | keep | no signal against it |
| unit/task-slice-move-generation.test.ts | 3 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/task-summaries.test.ts | 68 | 0 | 5 | 0/0/0 |  | keep | no signal against it |
| unit/task-switch-branch-base-config.test.ts | 7 | 0 | 4 | 0/0/0 |  | keep | no signal against it |
| unit/task-tagged-reap.test.ts | 83 | 0 | 8 | 0/0/0 | task-process-tag | keep | named as a rule enforcement |
| unit/task-take-conversation-expired-handler.test.ts | 14 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/task-template-vars-parity.test.ts | 34 | 0 | 9 | 0/0/0 | task-template-vars-parity | keep | named as a rule enforcement |
| unit/task-tree-probe.test.ts | 15 | 0 | 2 | 0/0/0 | task-process-tag | keep | named as a rule enforcement |
| unit/task-update-automations-refusal.test.ts | 16 | 0 | 4 | 0/0/0 |  | keep | no signal against it |
| unit/task-update-from-base.test.ts | 22 | 0 | 4 | 0/0/0 |  | keep | no signal against it |
| unit/task-update-pr-resolve.test.ts | 8 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/task-windows.test.ts | 6 | 0 | 1 | 0/0/0 | pop-out-surface-registry | keep | named as a rule enforcement |
| unit/task-worktree-folder.test.ts | 12 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/task-write-announce.test.ts | 30 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/taskkill-stale-parent.test.ts | 1 | 0 | 1 | 0/0/0 | task-process-tag | keep | named as a rule enforcement |
| unit/template-escape.test.ts | 12 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/template-vars.test.ts | 12 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/terminal-anchor-registry.test.ts | 7 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/terminal-arrival-focus-sites.test.ts | 7 | 0 | 5 | 0/0/0 | terminal-arrival-focus | keep | named as a rule enforcement |
| unit/terminal-arrival-focus.test.ts | 34 | 0 | 5 | 0/0/0 | agent-driven-focus terminal-arrival-focus | keep | named as a rule enforcement |
| unit/terminal-arrival-visibility.test.ts | 23 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/terminal-capture-registry.test.ts | 12 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/terminal-clipboard-backspace.test.ts | 4 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/terminal-clipboard-image-reference.test.ts | 22 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/terminal-clipboard-osc52.test.ts | 24 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/terminal-clipboard-user-interrupt.test.ts | 6 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/terminal-content-reveal.test.ts | 4 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/terminal-escape-release.test.ts | 3 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/terminal-font-size.test.ts | 4 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/terminal-force-collapse.test.ts | 16 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/terminal-input-content.test.ts | 34 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/terminal-input-path.test.ts | 8 | 0 | 2 | 0/0/0 | pty-host-out-of-process | keep | named as a rule enforcement |
| unit/terminal-key-encoding.test.ts | 34 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/terminal-link-handler.test.ts | 11 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/terminal-mount-registry.test.ts | 5 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/terminal-native-defaults.test.ts | 6 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/terminal-query-replies.test.ts | 7 | 0 | 1 | 0/0/0 | xterm-query-replies | keep | named as a rule enforcement |
| unit/terminal-repaint-wait.test.ts | 18 | 0 | 1 | 0/0/0 | command-terminal | keep | named as a rule enforcement |
| unit/terminal-selection-clean.test.ts | 5 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/terminal-session-swap-contract.test.ts | 6 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/terminal-submit-scheduler.test.ts | 56 | 0 | 12 | 0/0/0 |  | keep | no signal against it |
| unit/terminal-tab-color-presets.test.ts | 7 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/terminal-task-leftover-sweep.test.ts | 14 | 0 | 4 | 0/0/0 | task-process-tag | keep | named as a rule enforcement |
| unit/terminal-trace-listeners.test.ts | 7 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/terminal-trace-persist.test.ts | 5 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/terminal-visibility.test.ts | 15 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/terminal-webgl.test.ts | 48 | 0 | 9 | 0/0/0 |  | keep | no signal against it |
| unit/test-value-budget.test.ts | 0 | 0 | 0 | 0/0/0 | test-value | keep | named as a rule enforcement |
| unit/tested-tree.test.ts | 0 | 0 | 1 | 0/0/0 | test-value | keep | named as a rule enforcement |
| unit/text-target.test.ts | 31 | 0 | 1 | 0/0/0 | agent-driven-focus | keep | named as a rule enforcement |
| unit/theme-contrast.test.ts | 6 | 0 | 5 | 0/0/0 |  | keep | no signal against it |
| unit/theme-registry-parity.test.ts | 8 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/ticket-query.test.ts | 8 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/timed-slices.test.ts | 8 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/toast-exit-fallback.test.ts | 1 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/toast-negative-assertion.test.ts | 5 | 0 | 2 | 0/2/1 |  | keep | red with a product change in the window |
| unit/toast-store-hmr.test.ts | 20 | 0 | 5 | 0/0/0 | toast-shape | keep | named as a rule enforcement |
| unit/tool-diff.test.ts | 16 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/toolbar-collapse.test.ts | 9 | 0 | 1 | 0/0/0 | ui-conventions | keep | named as a rule enforcement |
| unit/tooltip-copy.test.ts | 8 | 0 | 1 | 0/0/0 | one-tooltip | keep | named as a rule enforcement |
| unit/tooltip.test.ts | 93 | 0 | 4 | 0/0/0 | keybindings-registry one-tooltip | keep | named as a rule enforcement |
| unit/transaction-helper.test.ts | 12 | 0 | 2 | 0/0/0 | retrieval-out-of-process | keep | named as a rule enforcement |
| unit/transcript-archive-fixes.test.ts | 11 | 0 | 5 | 0/0/0 |  | keep | no signal against it |
| unit/transcript-archive-reported-path.test.ts | 9 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/transcript-cache-retained-source-bytes.test.ts | 7 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/transcript-cache.test.ts | 7 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/transcript-chunker.test.ts | 26 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/transcript-cleanup.test.ts | 63 | 0 | 7 | 0/0/0 |  | keep | no signal against it |
| unit/transcript-final-reply-worker.test.ts | 5 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/transcript-format.test.ts | 39 | 0 | 4 | 0/0/0 |  | keep | no signal against it |
| unit/transcript-get-handler-revision-shortcircuit.test.ts | 4 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/transcript-history-ipc-handlers.test.ts | 50 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/transcript-legacy-conversion.test.ts | 7 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/transcript-methods-history-queue.test.ts | 15 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/transcript-mobile-sync.test.ts | 5 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/transcript-scope-adapter-flags.test.ts | 5 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/transcript-service-revision-memo.test.ts | 3 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/transcript-service-stat-fast-path.test.ts | 5 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/transcript-service-task.test.ts | 14 | 0 | 9 | 0/0/0 |  | keep | no signal against it |
| unit/transcript-service.test.ts | 19 | 0 | 6 | 0/0/0 |  | keep | no signal against it |
| unit/transcript-slice-around-uuid.test.ts | 11 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/transcript-task-delta.test.ts | 4 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/transcript-writer.test.ts | 43 | 0 | 5 | 0/0/0 |  | keep | no signal against it |
| unit/transcription-service-dictation-adoption.test.ts | 19 | 0 | 7 | 0/0/0 |  | keep | no signal against it |
| unit/transcription-service-mode.test.ts | 6 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/transcription-service-model-progress.test.ts | 8 | 0 | 5 | 0/0/0 |  | keep | no signal against it |
| unit/transient-debugger-wiring.test.ts | 16 | 0 | 5 | 0/0/0 |  | keep | no signal against it |
| unit/transient-recovery.test.ts | 20 | 0 | 4 | 0/0/0 |  | keep | no signal against it |
| unit/transient-session-adopt.test.ts | 4 | 0 | 2 | 0/0/0 | command-terminal | keep | named as a rule enforcement |
| unit/transient-session-branch.test.ts | 9 | 0 | 1 | 0/0/0 | command-terminal | keep | named as a rule enforcement |
| unit/transient-session-history-handlers.test.ts | 16 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/transient-session-kill-by-slot.test.ts | 6 | 0 | 2 | 0/0/0 | command-terminal | keep | named as a rule enforcement |
| unit/transient-session-kill-handler.test.ts | 4 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/transient-session-rename-handler.test.ts | 4 | 0 | 2 | 0/0/0 | command-terminal | keep | named as a rule enforcement |
| unit/transient-session-resume.test.ts | 32 | 0 | 9 | 0/0/0 | command-terminal | keep | named as a rule enforcement |
| unit/transient-session-set-branch-handler.test.ts | 3 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/transient-session-spawn-dirty-guard.test.ts | 55 | 0 | 8 | 0/0/0 | command-terminal | keep | named as a rule enforcement |
| unit/transient-session-spawn-ensure-trust.test.ts | 2 | 0 | 6 | 0/0/0 | command-terminal spawn-entry-point-parity | keep | named as a rule enforcement |
| unit/transient-session-spawn-shim-launch.test.ts | 8 | 0 | 9 | 0/0/0 | spawn-entry-point-parity task-process-tag | keep | named as a rule enforcement |
| unit/transition-engine-agent-reply-forwarding.test.ts | 6 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/transition-engine-expired-recap.test.ts | 23 | 0 | 5 | 0/0/0 |  | keep | no signal against it |
| unit/transition-engine.test.ts | 67 | 0 | 43 | 0/0/0 | spawn-entry-point-parity task-process-tag | keep | named as a rule enforcement |
| unit/translate-readme.test.ts | 37 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/tui-anchor-match.test.ts | 9 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/turn-completion.test.ts | 9 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/turn-end-runner-automations-disabled.test.ts | 14 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/turn-end-runner-resume-catch-up.test.ts | 18 | 0 | 7 | 0/0/0 |  | keep | no signal against it |
| unit/typecheck-demo-program.test.ts | 21 | 0 | 2 | 0/0/0 | web-demo-parity | keep | named as a rule enforcement |
| unit/updater-error-classifier.test.ts | 168 | 0 | 5 | 0/0/0 |  | keep | no signal against it |
| unit/updater-init-guard.test.ts | 14 | 0 | 7 | 0/0/0 |  | keep | no signal against it |
| unit/updater-release-notes.test.ts | 8 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/updater-retry.test.ts | 31 | 0 | 11 | 0/0/0 |  | keep | no signal against it |
| unit/updater-store-whats-new.test.ts | 7 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/updater-store.test.ts | 11 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/upload-native-debug-files.test.ts | 22 | 0 | 5 | 0/0/0 | release-gates-fail-loudly | keep | named as a rule enforcement |
| unit/usage-accumulator-compaction.test.ts | 10 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/usage-accumulator.test.ts | 79 | 0 | 16 | 0/0/0 |  | keep | no signal against it |
| unit/usage-commands-background.test.ts | 12 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/usage-commands-index-restarting.test.ts | 2 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/usage-commands-subagent-message.test.ts | 4 | 0 | 4 | 0/0/0 |  | keep | no signal against it |
| unit/usage-dashboard-helpers.test.ts | 29 | 0 | 7 | 0/0/0 |  | keep | no signal against it |
| unit/usage-dashboard-store-index-restarting.test.ts | 12 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/usage-history-migration.test.ts | 12 | 0 | 6 | 0/0/0 |  | keep | no signal against it |
| unit/usage-history-repository.test.ts | 16 | 0 | 8 | 0/0/0 |  | keep | no signal against it |
| unit/usage-kpi-tile-math.test.ts | 19 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/usage-stats-bucketing.test.ts | 45 | 0 | 7 | 0/0/0 |  | keep | no signal against it |
| unit/usage-stats-handler.test.ts | 9 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/usage-stats-service.test.ts | 45 | 0 | 16 | 0/2/0 |  | keep | no signal against it |
| unit/use-branch-settings-placeholder.test.ts | 7 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/use-browser-url-logic.test.ts | 13 | 0 | 3 | 0/0/0 |  | rewritten | asserts its own copy; extract and import the real logic |
| unit/use-graph-view-sums.test.ts | 15 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/use-now.test.ts | 5 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/use-task-split-resize.test.ts | 8 | 0 | 2 | 0/0/0 |  | rewritten | asserts its own copy; extract and import the real logic |
| unit/use-terminal-font-race.test.ts | 5 | 0 | 2 | 0/0/0 |  | rewritten | asserts its own copy; extract and import the real logic |
| unit/use-terminal-park-reveal.test.ts | 1 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/use-terminal-refit.test.ts | 16 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/use-terminal-refocus.test.ts | 5 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/use-terminal-scrollback.test.ts | 35 | 0 | 4 | 0/0/0 |  | removed | asserted its own copy, which contradicted production; no safe extraction |
| unit/user-interrupt-coordinator.test.ts | 13 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/utility-process-paths.test.ts | 4 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/utility-pty-host-transport.test.ts | 28 | 0 | 5 | 0/0/0 | pty-host-out-of-process task-process-tag | keep | named as a rule enforcement |
| unit/utility-restart-policy.test.ts | 41 | 0 | 9 | 0/0/0 |  | keep | no signal against it |
| unit/vec-layout-migration.test.ts | 3 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/verify-node-modules.test.ts | 23 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/verify-release-assets-main.test.ts | 8 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/verify-unpacked-worker.test.ts | 22 | 0 | 6 | 0/0/0 | dictation-out-of-process pty-host-out-of-process release-gates-fail-loudly retrieval-out-of-process | keep | named as a rule enforcement |
| unit/vite-navigation-retry.test.ts | 13 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/vite-prebundle.test.ts | 11 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/vite-refresh-hook-signatures.test.ts | 20 | 0 | 2 | 0/0/0 | hmr-patterns i18n | keep | named as a rule enforcement |
| unit/wait-for-churn-read.test.ts | 5 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/walkthrough-target-parity.test.ts | 4 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/warp-adapter.test.ts | 51 | 0 | 7 | 0/0/0 |  | keep | no signal against it |
| unit/webview-download-policy.test.ts | 15 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/webview-shim-guest-for.test.ts | 4 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/win32-reader-gates.test.ts | 63 | 0 | 9 | 0/0/0 | task-process-tag | keep | named as a rule enforcement |
| unit/window-capture-region-handler.test.ts | 25 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/window-drop-zone.test.ts | 25 | 0 | 4 | 0/0/0 |  | keep | no signal against it |
| unit/window-layer-isolation.test.ts | 11 | 0 | 5 | 0/0/0 | light-dismiss-denylist | keep | named as a rule enforcement |
| unit/window-manager.test.ts | 75 | 0 | 7 | 0/0/0 | command-terminal pop-out-surface-registry | keep | named as a rule enforcement |
| unit/window-open-policy.test.ts | 88 | 0 | 9 | 0/0/0 |  | keep | no signal against it |
| unit/window-parking-close-paths.test.ts | 5 | 0 | 2 | 0/0/0 | retained-pane-never-remounts | keep | named as a rule enforcement |
| unit/window-parking-policy.test.ts | 15 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/window-retention.test.ts | 38 | 0 | 3 | 0/0/0 | retained-pane-never-remounts | keep | named as a rule enforcement |
| unit/window-session-claims.test.ts | 4 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/window-snap-zones.test.ts | 10 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/window-store-agent-open.test.ts | 14 | 0 | 1 | 0/0/0 | agent-driven-focus | keep | named as a rule enforcement |
| unit/window-store-conversation-tab.test.ts | 14 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/window-tiling.test.ts | 35 | 0 | 4 | 0/0/0 | command-terminal | keep | named as a rule enforcement |
| unit/window-utils.test.ts | 28 | 0 | 5 | 0/0/0 |  | keep | no signal against it |
| unit/window-workspace.test.ts | 28 | 0 | 6 | 0/0/0 | restore-no-animation-replay | keep | named as a rule enforcement |
| unit/windows-cmd-shim-multiline-prompt.test.ts | 0 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/workflow-agent-capability.test.ts | 11 | 0 | 4 | 0/0/0 |  | keep | no signal against it |
| unit/workflow-agent-choice.test.ts | 8 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/workflow-agent-columns.test.ts | 3 | 0 | 4 | 0/0/0 |  | keep | no signal against it |
| unit/workflow-agent-continue-message.test.ts | 11 | 0 | 4 | 0/0/0 |  | keep | no signal against it |
| unit/workflow-agent-first-open.test.ts | 9 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/workflow-agent-launch-route.test.ts | 14 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/workflow-agent-prompt.test.ts | 4 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/workflow-agent-scope.test.ts | 9 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/workflow-canvas-arrange.test.ts | 5 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/workflow-canvas-card-heights.test.ts | 7 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/workflow-catch-up.test.ts | 11 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/workflow-changed.test.ts | 3 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/workflow-commands-format.test.ts | 9 | 0 | 7 | 0/0/0 |  | keep | no signal against it |
| unit/workflow-commands-phone-params.test.ts | 24 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/workflow-complete.test.ts | 4 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/workflow-core.test.ts | 76 | 0 | 6 | 0/0/0 |  | keep | no signal against it |
| unit/workflow-delete-command.test.ts | 7 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/workflow-engine-boundary.test.ts | 3 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/workflow-graph.test.ts | 20 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/workflow-handlers-set-positions.test.ts | 7 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/workflow-hang-check.test.ts | 14 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/workflow-home-links.test.ts | 8 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/workflow-ipc-handlers-report.test.ts | 5 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/workflow-layout.test.ts | 13 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/workflow-link-end-state.test.ts | 11 | 0 | 4 | 0/0/0 |  | keep | no signal against it |
| unit/workflow-links-geometry.test.ts | 5 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/workflow-memory-gate.test.ts | 12 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/workflow-needs-owner.test.ts | 10 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/workflow-never-started.test.ts | 4 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/workflow-refusals-english.test.ts | 4 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/workflow-refusals.test.ts | 59 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/workflow-step-condition.test.ts | 37 | 0 | 5 | 0/0/0 |  | keep | no signal against it |
| unit/workflow-step-turn-identity.test.ts | 59 | 0 | 11 | 0/0/0 |  | keep | no signal against it |
| unit/workflow-store-agent-refusal.test.ts | 21 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/workflow-store-pause-report.test.ts | 4 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/workflow-store-sharing.test.ts | 5 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/workflow-task-form.test.ts | 3 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/workflow-task-hold.test.ts | 27 | 0 | 4 | 0/0/0 |  | keep | no signal against it |
| unit/workflow-track.test.ts | 7 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/workflow-xml.test.ts | 8 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/workflows-migration-atomic.test.ts | 3 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/workspace-bridge-copy.test.ts | 10 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/worktree-choice.test.ts | 3 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/worktree-commits-since.test.ts | 5 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/worktree-creation-registry.test.ts | 14 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/worktree-folder.test.ts | 18 | 0 | 4 | 0/0/0 |  | keep | no signal against it |
| unit/worktree-head.test.ts | 54 | 0 | 9 | 0/0/0 |  | keep | no signal against it |
| unit/worktree-manager.test.ts | 116 | 0 | 46 | 0/0/0 |  | keep | no signal against it |
| unit/worktree-move-revert.test.ts | 5 | 0 | 1 | 0/0/0 |  | rewritten | asserts its own copy; extract and import the real logic |
| unit/worktree-placement.test.ts | 11 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/worktree-preview-env.test.ts | 13 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/worktree-preview-node-modules.test.ts | 9 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/worktree-removal-invariant.test.ts | 7 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/worktree-removal-own-creation.test.ts | 4 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/worktree-removal-stops-background-setup.test.ts | 6 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/worktree-reuse-drift.test.ts | 15 | 0 | 5 | 0/0/0 |  | keep | no signal against it |
| unit/worktree-task-lookup.test.ts | 17 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/worktree-vite-config.test.ts | 8 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/write-batcher.test.ts | 35 | 0 | 7 | 0/0/0 |  | keep | no signal against it |
| unit/write-budget.test.ts | 7 | 0 | 2 | 0/0/0 | retrieval-out-of-process | keep | named as a rule enforcement |
| unit/write-failure-notice.test.ts | 35 | 0 | 5 | 0/0/0 |  | keep | no signal against it |
| unit/write-queue.test.ts | 17 | 0 | 2 | 0/0/0 |  | keep | no signal against it |
| unit/writing-style-characters.test.ts | 8 | 0 | 6 | 0/0/0 | writing-style | keep | named as a rule enforcement |
| unit/wsl-adapter-headless-runs.test.ts | 35 | 0 | 5 | 0/0/0 |  | keep | no signal against it |
| unit/wsl-adapter-parity.test.ts | 15 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/wsl-distro.test.ts | 19 | 0 | 3 | 0/0/0 |  | keep | no signal against it |
| unit/wsl-mcp-relay.test.ts | 13 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/wsl-reap-script-budget.test.ts | 5 | 0 | 1 | 0/0/0 | task-process-tag | keep | named as a rule enforcement |
| unit/wsl-unc-paths.test.ts | 10 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/wsl-unread-distro-runs-nothing-here.test.ts | 2 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
| unit/xterm-unicode11-activation.test.ts | 6 | 0 | 4 | 0/0/0 | xterm-unicode11-parity | keep | named as a rule enforcement |
| unit/zombie-reaper.test.ts | 89 | 0 | 6 | 0/0/0 | task-process-tag | keep | named as a rule enforcement |
| unit/zoom-steps.test.ts | 19 | 0 | 1 | 0/0/0 |  | keep | no signal against it |
