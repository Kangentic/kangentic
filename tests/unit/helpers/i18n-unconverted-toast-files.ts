/**
 * Renderer files that still raise a toast with literal English in its title,
 * body or button, which the toast scan in tests/unit/i18n-hardcoded-text.test.ts
 * lets through until their area is extracted (GitHub #489). The JSX scan cannot
 * see these: a toast's text sits in an object literal, often in a `.ts` file.
 *
 * The list only shrinks: a listed file with no literal toast text left fails the
 * test, so a converted file comes off in the same change. Never add a file: put
 * its toast text through Lingui instead.
 *
 * Keyed by catalog area, the same way as helpers/i18n-unconverted-files.ts. A
 * separate file from that one, so the tasks still emptying that list never edit
 * this one.
 */
export const I18N_UNCONVERTED_TOAST_FILES: Record<string, readonly string[]> = {
  // ── #916: dialogs, task detail, backlog and workflows ──

  dialogs: [
    'src/renderer/components/dialogs/BoardManagerDialog.tsx',
    'src/renderer/components/dialogs/NewTaskDialog.tsx',
    'src/renderer/components/dialogs/ProjectPathMissingDialog.tsx',
    'src/renderer/components/dialogs/attachment-utils.ts',
    'src/renderer/components/dialogs/image-compress.ts',
    'src/renderer/components/dialogs/task-detail/TaskDetailHeader.tsx',
    'src/renderer/components/dialogs/task-detail/changes/ChangesPanel.tsx',
    'src/renderer/components/dialogs/task-detail/changes/FileTreePanel.tsx',
    'src/renderer/components/dialogs/task-detail/open-task-conversation.ts',
    'src/renderer/components/dialogs/task-detail/useAttachments.ts',
    'src/renderer/components/dialogs/task-detail/useCopyDisplayId.ts',
    'src/renderer/components/dialogs/task-detail/useTaskActions.ts',
  ],

  backlog: [
    'src/renderer/components/backlog/ImportDialog.tsx',
    'src/renderer/components/backlog/NewBacklogTaskDialog.tsx',
  ],

  workflows: [
    'src/renderer/components/workflows/TaskWorkflowPanel.tsx',
    'src/renderer/components/workflows/WorkflowCardMenu.tsx',
    'src/renderer/components/workflows/WorkflowsView.tsx',
  ],
};
