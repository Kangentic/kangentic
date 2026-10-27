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

  // ── #917: board, panels, toasts and the rest of the renderer ──

  board: [
    'src/renderer/components/board/ActivityReasonTooltip.tsx',
    'src/renderer/components/board/ArchivedTaskContextMenu.tsx',
    'src/renderer/components/board/BoardDialogs.tsx',
    'src/renderer/components/board/DeleteTaskDialog.tsx',
    'src/renderer/components/board/DoneSwimlane.tsx',
    'src/renderer/components/board/KanbanBoard.tsx',
    'src/renderer/components/board/SendToBacklogDialog.tsx',
    'src/renderer/components/board/Swimlane.tsx',
    'src/renderer/components/board/TaskContextMenu.tsx',
    'src/renderer/components/board/ViewToggle.tsx',
    'src/renderer/components/board/task-card-view.tsx',
    'src/renderer/components/board/workflow-menu-items.tsx',
  ],

  'knowledge-graph': [
    'src/renderer/components/knowledge-graph/KnowledgeGraphBody.tsx',
    'src/renderer/components/knowledge-graph/KnowledgeGraphCanvas.tsx',
    'src/renderer/components/knowledge-graph/KnowledgeGraphChat.tsx',
    'src/renderer/components/knowledge-graph/KnowledgeGraphControls.tsx',
    'src/renderer/components/knowledge-graph/KnowledgeGraphIndexCard.tsx',
    'src/renderer/components/knowledge-graph/KnowledgeGraphNoMap.tsx',
    'src/renderer/components/knowledge-graph/KnowledgeGraphNodeDetail.tsx',
    'src/renderer/components/knowledge-graph/KnowledgeGraphPage.tsx',
    'src/renderer/components/knowledge-graph/KnowledgeGraphProjectsPicker.tsx',
    'src/renderer/components/knowledge-graph/KnowledgeGraphSourceRows.tsx',
    'src/renderer/components/knowledge-graph/LazyKnowledgeGraph.tsx',
    'src/renderer/components/knowledge-graph/PanelRow.tsx',
    'src/renderer/components/knowledge-graph/TaskPriorWork.tsx',
    'src/renderer/components/knowledge-graph/panel-card.tsx',
  ],

  stats: [
    'src/renderer/components/stats/BackgroundCard.tsx',
    'src/renderer/components/stats/BackgroundHistoryCard.tsx',
    'src/renderer/components/stats/KpiTiles.tsx',
    'src/renderer/components/stats/LazyStatsDashboard.tsx',
    'src/renderer/components/stats/PerProjectTable.tsx',
    'src/renderer/components/stats/StatsCustomRangePicker.tsx',
    'src/renderer/components/stats/StatsDashboardBody.tsx',
    'src/renderer/components/stats/StatsFilterRow.tsx',
    'src/renderer/components/stats/StatsMetricToggle.tsx',
    'src/renderer/components/stats/StatsPage.tsx',
    'src/renderer/components/stats/StatsScopePicker.tsx',
  ],

  browser: [
    'src/renderer/components/browser/AttachmentChips.tsx',
    'src/renderer/components/browser/BrowserEmptyState.tsx',
    'src/renderer/components/browser/BrowserPane.tsx',
  ],

  monitor: [
    'src/renderer/components/monitor/LazyMonitor.tsx',
    'src/renderer/components/monitor/MonitorBody.tsx',
    'src/renderer/components/monitor/MonitorCard.tsx',
    'src/renderer/components/monitor/MonitorPage.tsx',
    'src/renderer/components/monitor/MonitorRowContextMenu.tsx',
    'src/renderer/components/monitor/MonitorSummaryCards.tsx',
    'src/renderer/components/monitor/MonitorTable.tsx',
    'src/renderer/components/monitor/MonitorToolbar.tsx',
  ],

  layout: [
    'src/renderer/components/layout/AppLayout.tsx',
    'src/renderer/components/layout/StatusBar.tsx',
    'src/renderer/components/layout/TitleBar.tsx',
    'src/renderer/components/layout/ToastItem.tsx',
    'src/renderer/components/layout/WelcomeScreen.tsx',
  ],

  sidebar: [
    'src/renderer/components/sidebar/CollapsedRail.tsx',
    'src/renderer/components/sidebar/ProjectSidebar.tsx',
    'src/renderer/components/sidebar/project-sidebar/GroupContextMenu.tsx',
    'src/renderer/components/sidebar/project-sidebar/GroupHeader.tsx',
    'src/renderer/components/sidebar/project-sidebar/ProjectContextMenu.tsx',
    'src/renderer/components/sidebar/project-sidebar/ProjectListItem.tsx',
    'src/renderer/components/sidebar/project-sidebar/SidebarBackgroundMenu.tsx',
    'src/renderer/components/sidebar/project-sidebar/SidebarCommandTerminalIndicator.tsx',
    'src/renderer/components/sidebar/project-sidebar/SidebarFooterActions.tsx',
  ],

  terminal: [
    'src/renderer/components/terminal/ActivityLog.tsx',
    'src/renderer/components/terminal/ContextBar.tsx',
    'src/renderer/components/terminal/ContextBarPopover.tsx',
    'src/renderer/components/terminal/FileDropOverlay.tsx',
    'src/renderer/components/terminal/ModelEffortPicker.tsx',
    'src/renderer/components/terminal/ProfilePicker.tsx',
    'src/renderer/components/terminal/TerminalPanel.tsx',
    'src/renderer/components/terminal/ToolBreakdownPopover.tsx',
  ],

  'command-bar': [
    'src/renderer/components/command-bar/CommandTerminalPanel.tsx',
    'src/renderer/components/command-bar/CommandTerminalRail.tsx',
    'src/renderer/components/command-bar/CommandTerminalWindow.tsx',
    'src/renderer/components/command-bar/NewTerminalButton.tsx',
  ],

  search: [
    'src/renderer/components/search/SearchPalette.tsx',
  ],

  conversation: [
    'src/renderer/components/conversation/ConversationBody.tsx',
    'src/renderer/components/conversation/ConversationScrollbar.tsx',
    'src/renderer/components/conversation/ConversationSearchBar.tsx',
    'src/renderer/components/conversation/ConversationView.tsx',
  ],

  announcements: [
    'src/renderer/components/announcements/AnnouncementBanner.tsx',
    'src/renderer/components/announcements/AnnouncementDialog.tsx',
    'src/renderer/components/announcements/AnnouncementHistoryDialog.tsx',
  ],

  dictation: [
    'src/renderer/components/dictation/LiveDictationChip.tsx',
  ],

  shared: [
    'src/renderer/components/shared/ByToolTable.tsx',
  ],

  'src-renderer': [
    'src/renderer/components/DataTable.tsx',
    'src/renderer/components/DescriptionEditor.tsx',
    'src/renderer/components/ErrorBoundary.tsx',
    'src/renderer/components/FilterPopover.tsx',
    'src/renderer/components/IsolatedBadge.tsx',
    'src/renderer/components/LabelInput.tsx',
    'src/renderer/components/MultiSelectDropdown.tsx',
    'src/renderer/components/NameFromPromptButton.tsx',
    'src/renderer/components/NumberStepper.tsx',
    'src/renderer/components/OptionalTag.tsx',
    'src/renderer/components/PanelErrorBoundary.tsx',
    'src/renderer/components/PrLink.tsx',
    'src/renderer/components/TemplateTextField.tsx',
    'src/renderer/components/TemplateVariablePicker.tsx',
    'src/renderer/components/ToolbarSearchFilter.tsx',
    'src/renderer/hooks/useProjectRelocation.tsx',
    'src/renderer/pop-out/PopOutWindowFrame.tsx',
    'src/renderer/pop-out/roots/PopOutBrowserRoot.tsx',
    'src/renderer/pop-out/roots/PopOutChangesFileRoot.tsx',
    'src/renderer/pop-out/roots/PopOutChangesRoot.tsx',
    'src/renderer/pop-out/roots/PopOutCommandTerminalRoot.tsx',
    'src/renderer/utils/worktree-placement.tsx',
    'src/renderer/window-manager/components/ConversationWindow.tsx',
    'src/renderer/window-manager/components/TaskDetailWindow.tsx',
    'src/renderer/window-manager/components/WindowContent.tsx',
    'src/renderer/window-manager/components/WindowTitleBar.tsx',
  ],
};
