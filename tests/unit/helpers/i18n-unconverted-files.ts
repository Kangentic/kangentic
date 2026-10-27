/**
 * Renderer files that still hold hard-coded UI text, which
 * tests/unit/i18n-hardcoded-text.test.ts lets through until their area is
 * extracted (GitHub #489). The list only shrinks: a listed file with no
 * hard-coded text left fails the test, so a converted file comes off in the same
 * change. Never add a file: put its text through Lingui instead.
 *
 * Keyed by catalog area (the PO file the area extracts into, lingui.config.ts),
 * and grouped by the extraction task that owns it, with a blank line between
 * areas, so tasks emptying different areas edit lines git can merge.
 */
export const I18N_UNCONVERTED_FILES: Record<string, readonly string[]> = {
  // ── #916: dialogs, task detail, backlog and workflows ──

  dialogs: [
    'src/renderer/components/dialogs/AdvancedOverridesSection.tsx',
    'src/renderer/components/dialogs/AttachmentChipStrip.tsx',
    'src/renderer/components/dialogs/BaseDialog.tsx',
    'src/renderer/components/dialogs/BoardManagerDialog.tsx',
    'src/renderer/components/dialogs/BranchPicker.tsx',
    'src/renderer/components/dialogs/Combobox.tsx',
    'src/renderer/components/dialogs/CompletedTasksDialog.tsx',
    'src/renderer/components/dialogs/DialogFooterActions.tsx',
    'src/renderer/components/dialogs/FontCombobox.tsx',
    'src/renderer/components/dialogs/IconPickerDialog.tsx',
    'src/renderer/components/dialogs/LeftoverProcessesDialog.tsx',
    'src/renderer/components/dialogs/ModelCombobox.tsx',
    'src/renderer/components/dialogs/NewTaskDialog.tsx',
    'src/renderer/components/dialogs/PausedForMemoryDialog.tsx',
    'src/renderer/components/dialogs/PriorityLabelsRow.tsx',
    'src/renderer/components/dialogs/ProjectPathMissingDialog.tsx',
    'src/renderer/components/dialogs/ReleaseNotesDialog.tsx',
    'src/renderer/components/dialogs/TaskBranchRow.tsx',
    'src/renderer/components/dialogs/TaskChangesDialog.tsx',
    'src/renderer/components/dialogs/WhatsNewDialog.tsx',
    'src/renderer/components/dialogs/WorktreePlacementControl.tsx',
    'src/renderer/components/dialogs/board-manager/AddAutomationPicker.tsx',
    'src/renderer/components/dialogs/board-manager/AutomationTypePicker.tsx',
    'src/renderer/components/dialogs/board-manager/AutomationsPane.tsx',
    'src/renderer/components/dialogs/board-manager/ColumnRail.tsx',
    'src/renderer/components/dialogs/board-manager/ColumnsOverview.tsx',
    'src/renderer/components/dialogs/board-manager/EditAutomationDialog.tsx',
    'src/renderer/components/dialogs/board-manager/ProfileBar.tsx',
    'src/renderer/components/dialogs/board-manager/ProfileNameDialog.tsx',
    'src/renderer/components/dialogs/board-manager/WildcardExamplesTip.tsx',
    'src/renderer/components/dialogs/board-manager/form-layout.tsx',
    'src/renderer/components/dialogs/completed-tasks/BulkToolbar.tsx',
    'src/renderer/components/dialogs/completed-tasks/RestorePopover.tsx',
    'src/renderer/components/dialogs/completed-tasks/RowActions.tsx',
    'src/renderer/components/dialogs/task-detail/CommandSearchList.tsx',
    'src/renderer/components/dialogs/task-detail/HandoffTimeline.tsx',
    'src/renderer/components/dialogs/task-detail/QueuedPlaceholder.tsx',
    'src/renderer/components/dialogs/task-detail/TaskDetailBody.tsx',
    'src/renderer/components/dialogs/task-detail/TaskDetailEditForm.tsx',
    'src/renderer/components/dialogs/task-detail/TaskDetailHeader.tsx',
    'src/renderer/components/dialogs/task-detail/changes/ChangesHistorySection.tsx',
    'src/renderer/components/dialogs/task-detail/changes/ChangesPanel.tsx',
    'src/renderer/components/dialogs/task-detail/changes/CommitSelectionBar.tsx',
    'src/renderer/components/dialogs/task-detail/changes/DiffErrorBoundary.tsx',
    'src/renderer/components/dialogs/task-detail/changes/DiffViewOptionsMenu.tsx',
    'src/renderer/components/dialogs/task-detail/changes/DiffViewer.tsx',
    'src/renderer/components/dialogs/task-detail/changes/FileTreePanel.tsx',
    'src/renderer/components/dialogs/task-detail/changes/ImageDiffView.tsx',
    'src/renderer/components/dialogs/task-detail/completed/CompletedChangesTab.tsx',
    'src/renderer/components/dialogs/task-detail/completed/CompletedConversationTab.tsx',
    'src/renderer/components/dialogs/task-detail/completed/CompletedHeaderStrip.tsx',
    'src/renderer/components/dialogs/task-detail/completed/CompletedTaskView.tsx',
    'src/renderer/components/dialogs/task-detail/completed/SummaryTab.tsx',
    'src/renderer/components/dialogs/task-detail/completed/UsageTab.tsx',
    'src/renderer/components/dialogs/task-detail/completed/report-parts.tsx',
    'src/renderer/components/dialogs/task-detail/graph/CommitGraphPanel.tsx',
    'src/renderer/components/dialogs/task-detail/graph/CommitGraphSvg.tsx',
  ],

  backlog: [
    'src/renderer/components/backlog/BacklogBulkToolbar.tsx',
    'src/renderer/components/backlog/BacklogContextMenu.tsx',
    'src/renderer/components/backlog/BacklogDialogs.tsx',
    'src/renderer/components/backlog/BacklogView.tsx',
    'src/renderer/components/backlog/ImportDialog.tsx',
    'src/renderer/components/backlog/ImportPopover.tsx',
    'src/renderer/components/backlog/NewBacklogTaskDialog.tsx',
    'src/renderer/components/backlog/PromotePopover.tsx',
    'src/renderer/components/backlog/manage-labels/ColorPickerPopover.tsx',
    'src/renderer/components/backlog/manage-labels/LabelsPopover.tsx',
    'src/renderer/components/backlog/manage-labels/PrioritiesPopover.tsx',
    'src/renderer/components/backlog/view/BacklogRowActions.tsx',
    'src/renderer/components/backlog/view/useBacklogColumns.tsx',
  ],

  workflows: [
    'src/renderer/components/workflows/LazyWorkflowsView.tsx',
    'src/renderer/components/workflows/TaskWorkflowPanel.tsx',
    'src/renderer/components/workflows/WorkflowAgentPane.tsx',
    'src/renderer/components/workflows/WorkflowCanvas.tsx',
    'src/renderer/components/workflows/WorkflowCardMenu.tsx',
    'src/renderer/components/workflows/WorkflowDialogs.tsx',
    'src/renderer/components/workflows/WorkflowHeader.tsx',
    'src/renderer/components/workflows/WorkflowInspector.tsx',
    'src/renderer/components/workflows/WorkflowPicker.tsx',
    'src/renderer/components/workflows/WorkflowStrip.tsx',
    'src/renderer/components/workflows/WorkflowTaskNode.tsx',
    'src/renderer/components/workflows/WorkflowsView.tsx',
  ],

  asana: [
    'src/renderer/components/asana/AsanaSetupDialog.tsx',
  ],

  onboarding: [
    'src/renderer/components/onboarding/OverseerMascot.tsx',
    'src/renderer/components/onboarding/WalkthroughLayer.tsx',
    'src/renderer/components/onboarding/WelcomeChecklistDialog.tsx',
  ],
};
