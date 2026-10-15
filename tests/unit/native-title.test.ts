import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import * as ts from 'typescript';
import { hasJsxOptOutMarker } from './helpers/opt-out-marker';

// Guards `.claude/rules/one-tooltip.md`: hover text in the renderer is HoverTip
// (src/renderer/components/HoverTip.tsx). A native `title` is slow, unstyled,
// never shown to a keyboard user, cannot draw key chips, and is tested only as
// an attribute, so it survives in one case: the full value of text the layout
// cuts short (a truncated path or branch name), where the value IS the text.
// That case is marked `// native-title-ok: full value of <the thing>`, and the
// reason has to start with "full value of", so a keeper cannot quietly become
// an explanation.
//
// What counts as a native tooltip:
//  - a `title` attribute on an intrinsic element (a lowercase tag),
//  - an SVG `<title>` element,
//  - an object literal spread onto an intrinsic element that carries `title`.
// A component prop named `title` is never visited: on ConfirmDialog, BaseDialog
// and the rest it is a heading, and a component that forwards a tooltip either
// renders HoverTip or ends at an intrinsic `title=`, which this scan sees.
//
// The scan parses the TSX AST, as clickable-control-select-none.test.ts does: a
// regex truncates at the `>` inside `onClick={() => ...}` and misreads tags whose
// attributes span lines.

const REPO_ROOT = path.resolve(__dirname, '../..');
const RENDERER_ROOT = path.join(REPO_ROOT, 'src/renderer');
const MARKER = 'native-title-ok';
const REASON_PREFIX = 'full value of';

/** Dev-only overlays, built out of production; they keep their raw titles on purpose. */
const EXEMPT_DIRECTORY = 'src/renderer/components/debug/';

interface NativeTitleSite {
  file: string;
  line: number;
  kind: 'attribute' | 'svg-title' | 'spread';
  tagName: string;
  marked: boolean;
  /** The marker's reason when marked, else ''. */
  reason: string;
}

function collectTsxFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...collectTsxFiles(fullPath));
    else if (entry.name.endsWith('.tsx')) found.push(fullPath);
  }
  return found;
}

function isIntrinsic(tagName: string): boolean {
  return /^[a-z][\w-]*$/.test(tagName);
}

/** The reason text of the nearest marker at or above `lineIndex`, no higher than `floor`. */
function markerReason(lines: string[], lineIndex: number, floor: number): string {
  const pattern = new RegExp(`${MARKER}:[^\\S\\r\\n]*(.*?)\\s*(?:\\*\\/\\s*\\}?)?$`);
  for (let scan = lineIndex; scan >= Math.max(0, floor); scan--) {
    const match = pattern.exec(lines[scan] ?? '');
    if (match) return match[1].trim();
  }
  return '';
}

// Takes the source text rather than a path so the detector can be driven over
// known-bad input below; a broken visitor would otherwise report nothing and
// every case would pass.
function scanSource(fileLabel: string, source: string): NativeTitleSite[] {
  const sourceFile = ts.createSourceFile(fileLabel, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const lines = source.split('\n');
  const found: NativeTitleSite[] = [];

  function record(node: ts.Node, element: ts.Node, kind: NativeTitleSite['kind'], tagName: string): void {
    const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line;
    const elementLine = sourceFile.getLineAndCharacterOfPosition(element.getStart(sourceFile)).line;
    const marked = hasJsxOptOutMarker(lines, line, MARKER);
    found.push({
      file: fileLabel,
      line: line + 1,
      kind,
      tagName,
      marked,
      reason: marked ? markerReason(lines, line, elementLine - 6) : '',
    });
  }

  function visit(node: ts.Node): void {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tagName = node.tagName.getText(sourceFile);
      if (tagName === 'title') record(node, node, 'svg-title', tagName);
      if (isIntrinsic(tagName)) {
        for (const property of node.attributes.properties) {
          if (ts.isJsxAttribute(property) && property.name.getText(sourceFile) === 'title') {
            record(property, node, 'attribute', tagName);
          } else if (
            ts.isJsxSpreadAttribute(property)
            && ts.isObjectLiteralExpression(property.expression)
            && property.expression.properties.some((member) => member.name?.getText(sourceFile) === 'title')
          ) {
            record(property, node, 'spread', tagName);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return found;
}

function relative(filePath: string): string {
  return path.relative(REPO_ROOT, filePath).replace(/\\/g, '/');
}

const rendererTsxFiles = collectTsxFiles(RENDERER_ROOT);
const allSites = rendererTsxFiles.flatMap((filePath) => scanSource(relative(filePath), fs.readFileSync(filePath, 'utf-8')));
const scannedSites = allSites.filter((site) => !site.file.startsWith(EXEMPT_DIRECTORY));

/**
 * Unmarked native titles per file, while the migration to HoverTip is in flight. Exact: a count
 * above its entry is a new native title, and a count below it means a file moved and its entry
 * must come down with it. Deleted once the migration lands, after which every site is either a
 * HoverTip or a marked keeper.
 */
const BASELINE: Record<string, number> = {
  'src/renderer/components/ButtonGroup.tsx': 1,
  'src/renderer/components/DataTable.tsx': 2,
  'src/renderer/components/DescriptionEditor.tsx': 1,
  'src/renderer/components/IsolatedBadge.tsx': 1,
  'src/renderer/components/KebabMenu.tsx': 2,
  'src/renderer/components/NameFromPromptButton.tsx': 1,
  'src/renderer/components/PrLink.tsx': 1,
  'src/renderer/components/SegmentedControl.tsx': 1,
  'src/renderer/components/TemplateTextField.tsx': 1,
  'src/renderer/components/TemplateVariablePicker.tsx': 1,
  'src/renderer/components/ToggleCard.tsx': 1,
  'src/renderer/components/ToolbarSearchFilter.tsx': 1,

  'src/renderer/components/announcements/AnnouncementBanner.tsx': 1,
  'src/renderer/components/announcements/AnnouncementHistoryDialog.tsx': 1,

  'src/renderer/components/backlog/ImportDialog.tsx': 1,
  'src/renderer/components/backlog/ImportPopover.tsx': 1,
  'src/renderer/components/backlog/NewBacklogTaskDialog.tsx': 1,

  'src/renderer/components/backlog/manage-labels/ColorPickerPopover.tsx': 1,
  'src/renderer/components/backlog/manage-labels/LabelsPopover.tsx': 4,
  'src/renderer/components/backlog/manage-labels/PrioritiesPopover.tsx': 4,

  'src/renderer/components/backlog/view/BacklogRowActions.tsx': 3,
  'src/renderer/components/backlog/view/useBacklogColumns.tsx': 1,

  'src/renderer/components/board/AutomationGlyph.tsx': 1,
  'src/renderer/components/board/DoneSwimlane.tsx': 1,
  'src/renderer/components/board/Swimlane.tsx': 3,
  'src/renderer/components/board/TaskContextMenu.tsx': 3,
  'src/renderer/components/board/ViewToggle.tsx': 3,
  'src/renderer/components/board/task-card-view.tsx': 3,

  'src/renderer/components/browser/AttachmentChips.tsx': 2,
  'src/renderer/components/browser/BrowserEmptyState.tsx': 1,
  'src/renderer/components/browser/BrowserPane.tsx': 15,

  'src/renderer/components/command-bar/CommandTerminalWindow.tsx': 4,

  'src/renderer/components/dialogs/AdvancedOverridesSection.tsx': 2,
  'src/renderer/components/dialogs/AttachmentChipStrip.tsx': 2,
  'src/renderer/components/dialogs/BaseDialog.tsx': 1,
  'src/renderer/components/dialogs/BoardManagerDialog.tsx': 4,
  'src/renderer/components/dialogs/BranchPicker.tsx': 1,
  'src/renderer/components/dialogs/Combobox.tsx': 3,
  'src/renderer/components/dialogs/DialogFooterActions.tsx': 1,
  'src/renderer/components/dialogs/FontCombobox.tsx': 2,
  'src/renderer/components/dialogs/IconPickerDialog.tsx': 2,
  'src/renderer/components/dialogs/LeftoverProcessesDialog.tsx': 1,
  'src/renderer/components/dialogs/ModelCombobox.tsx': 8,
  'src/renderer/components/dialogs/WorktreePlacementControl.tsx': 1,

  'src/renderer/components/dialogs/board-manager/AutomationTypePicker.tsx': 1,
  'src/renderer/components/dialogs/board-manager/AutomationsPane.tsx': 3,
  'src/renderer/components/dialogs/board-manager/ColumnRail.tsx': 5,
  'src/renderer/components/dialogs/board-manager/ColumnsOverview.tsx': 5,
  'src/renderer/components/dialogs/board-manager/ProfileBar.tsx': 4,
  'src/renderer/components/dialogs/board-manager/automation-icons.tsx': 1,
  'src/renderer/components/dialogs/board-manager/form-layout.tsx': 1,

  'src/renderer/components/dialogs/completed-tasks/RowActions.tsx': 3,
  'src/renderer/components/dialogs/completed-tasks/StaleTaskWarning.tsx': 1,
  'src/renderer/components/dialogs/completed-tasks/useCompletedColumns.tsx': 1,

  'src/renderer/components/dialogs/dialog-maximize.tsx': 1,

  'src/renderer/components/dialogs/task-detail/TaskDetailBody.tsx': 1,
  'src/renderer/components/dialogs/task-detail/TaskDetailHeader.tsx': 4,

  'src/renderer/components/dialogs/task-detail/changes/ChangesHistorySection.tsx': 3,
  'src/renderer/components/dialogs/task-detail/changes/ChangesPanel.tsx': 11,
  'src/renderer/components/dialogs/task-detail/changes/DiffViewer.tsx': 7,
  'src/renderer/components/dialogs/task-detail/changes/FileTreePanel.tsx': 11,
  'src/renderer/components/dialogs/task-detail/changes/ImageDiffView.tsx': 3,

  'src/renderer/components/dialogs/task-detail/completed/CompletedHeaderStrip.tsx': 7,
  'src/renderer/components/dialogs/task-detail/completed/CompletedTaskView.tsx': 1,
  'src/renderer/components/dialogs/task-detail/completed/SummaryTab.tsx': 4,
  'src/renderer/components/dialogs/task-detail/completed/UsageTab.tsx': 8,
  'src/renderer/components/dialogs/task-detail/completed/report-parts.tsx': 2,

  'src/renderer/components/dialogs/task-detail/graph/CommitGraphPanel.tsx': 1,

  'src/renderer/components/dictation/LiveDictationChip.tsx': 1,

  'src/renderer/components/knowledge-graph/KnowledgeGraphCanvas.tsx': 2,
  'src/renderer/components/knowledge-graph/KnowledgeGraphChat.tsx': 1,
  'src/renderer/components/knowledge-graph/KnowledgeGraphChatText.tsx': 2,
  'src/renderer/components/knowledge-graph/KnowledgeGraphControls.tsx': 1,
  'src/renderer/components/knowledge-graph/KnowledgeGraphNodeDetail.tsx': 3,
  'src/renderer/components/knowledge-graph/KnowledgeGraphPage.tsx': 1,
  'src/renderer/components/knowledge-graph/KnowledgeGraphProjectsPicker.tsx': 3,
  'src/renderer/components/knowledge-graph/KnowledgeGraphSourceRows.tsx': 1,
  'src/renderer/components/knowledge-graph/PanelRow.tsx': 1,
  'src/renderer/components/knowledge-graph/TaskPriorWork.tsx': 1,
  'src/renderer/components/knowledge-graph/panel-card.tsx': 1,

  'src/renderer/components/layout/TitleBar.tsx': 14,
  'src/renderer/components/layout/ToastItem.tsx': 1,
  'src/renderer/components/layout/WelcomeScreen.tsx': 4,

  'src/renderer/components/monitor/MonitorCard.tsx': 2,
  'src/renderer/components/monitor/MonitorPage.tsx': 1,
  'src/renderer/components/monitor/MonitorSummaryCards.tsx': 1,
  'src/renderer/components/monitor/MonitorToolbar.tsx': 2,

  'src/renderer/components/search/SearchPalette.tsx': 3,

  'src/renderer/components/settings/keybindings/HotkeyRow.tsx': 2,

  'src/renderer/components/settings/settings-card.tsx': 2,
  'src/renderer/components/settings/shared.tsx': 2,

  'src/renderer/components/settings/tabs/AgentTab.tsx': 2,
  'src/renderer/components/settings/tabs/DictationTab.tsx': 1,
  'src/renderer/components/settings/tabs/GeneralTab.tsx': 1,
  'src/renderer/components/settings/tabs/McpServerTab.tsx': 1,
  'src/renderer/components/settings/tabs/MobileDevicesTab.tsx': 8,
  'src/renderer/components/settings/tabs/ShortcutsTab.tsx': 3,
  'src/renderer/components/settings/tabs/TerminalTab.tsx': 1,
  'src/renderer/components/settings/tabs/WorkflowAgentPromptField.tsx': 1,
  'src/renderer/components/settings/tabs/agent-execution-fields.tsx': 1,

  'src/renderer/components/shared/ByToolTable.tsx': 2,

  'src/renderer/components/sidebar/CollapsedRail.tsx': 3,
  'src/renderer/components/sidebar/ProjectSidebar.tsx': 2,

  'src/renderer/components/sidebar/project-sidebar/GroupHeader.tsx': 1,
  'src/renderer/components/sidebar/project-sidebar/ProjectListItem.tsx': 2,
  'src/renderer/components/sidebar/project-sidebar/SidebarCommandTerminalIndicator.tsx': 1,
  'src/renderer/components/sidebar/project-sidebar/SidebarFooterActions.tsx': 3,

  'src/renderer/components/stats/BackgroundCard.tsx': 1,
  'src/renderer/components/stats/BackgroundHistoryCard.tsx': 2,
  'src/renderer/components/stats/BreakdownCard.tsx': 1,
  'src/renderer/components/stats/CompactTile.tsx': 2,
  'src/renderer/components/stats/KpiTiles.tsx': 1,
  'src/renderer/components/stats/StatsCustomRangePicker.tsx': 3,
  'src/renderer/components/stats/StatsDashboardBody.tsx': 1,
  'src/renderer/components/stats/StatsFilterRow.tsx': 1,
  'src/renderer/components/stats/StatsPage.tsx': 1,
  'src/renderer/components/stats/StatsScopePicker.tsx': 1,

  'src/renderer/components/stats/charts/KngDonut.tsx': 1,

  'src/renderer/components/terminal/ContextBar.tsx': 13,
  'src/renderer/components/terminal/ContextBarPopover.tsx': 5,
  'src/renderer/components/terminal/ModelEffortPicker.tsx': 4,
  'src/renderer/components/terminal/ProfilePicker.tsx': 1,
  'src/renderer/components/terminal/TerminalPanel.tsx': 3,

  'src/renderer/components/workflows/TaskWorkflowPanel.tsx': 1,
  'src/renderer/components/workflows/WorkflowAgentPane.tsx': 7,
  'src/renderer/components/workflows/WorkflowCanvas.tsx': 3,
  'src/renderer/components/workflows/WorkflowHeader.tsx': 7,
  'src/renderer/components/workflows/WorkflowInspector.tsx': 12,
  'src/renderer/components/workflows/WorkflowPicker.tsx': 2,
  'src/renderer/components/workflows/WorkflowStrip.tsx': 4,

  'src/renderer/pop-out/PopOutButton.tsx': 1,
  'src/renderer/pop-out/PopOutWindowFrame.tsx': 4,

  'src/renderer/window-manager/components/ConversationWindow.tsx': 2,
  'src/renderer/window-manager/components/TaskDetailWindow.tsx': 2,
  'src/renderer/window-manager/components/WindowTitleBar.tsx': 1,
};

function unmarkedCounts(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const site of scannedSites) {
    if (site.marked) continue;
    counts[site.file] = (counts[site.file] ?? 0) + 1;
  }
  return counts;
}

/** The counts as a pasteable BASELINE body, grouped by directory with a blank line between groups. */
function baselineLiteral(counts: Record<string, number>): string {
  const lines: string[] = [];
  let previousDirectory = '';
  for (const file of Object.keys(counts).sort()) {
    const directory = path.posix.dirname(file);
    if (previousDirectory !== '' && directory !== previousDirectory) lines.push('');
    previousDirectory = directory;
    lines.push(`  '${file}': ${counts[file]},`);
  }
  return lines.join('\n');
}

describe('native titles in the renderer', () => {
  it('has no native title beyond the migration baseline', () => {
    const counts = unmarkedCounts();
    expect(
      counts,
      'Native `title` counts changed. A new one should be a HoverTip; a full value of cut-short\n'
        + `text is marked \`// ${MARKER}: ${REASON_PREFIX} <the thing>\`. If a file moved to HoverTip,\n`
        + `lower its entry. The current counts, to paste into BASELINE:\n${baselineLiteral(counts)}`,
    ).toEqual(BASELINE);
  });

  it('marks keepers only for the full value of cut-short text', () => {
    const wrongReason = scannedSites
      .filter((site) => site.marked && !site.reason.startsWith(REASON_PREFIX))
      .map((site) => `  ${site.file}:${site.line} "${site.reason}"`);
    expect(wrongReason, `A ${MARKER} reason must start with "${REASON_PREFIX}":\n${wrongReason.join('\n')}`).toEqual([]);
  });

  it('scans a meaningful number of renderer components', () => {
    expect(rendererTsxFiles.length).toBeGreaterThan(100);
  });

  // The exemption is a decision, so it must be the reason those sites are
  // skipped: if the walk stopped reaching the folder, this would say so instead
  // of the exemption silently covering nothing.
  it('reaches the exempt debug overlays and skips them only by the exemption', () => {
    expect(allSites.some((site) => site.file.startsWith(EXEMPT_DIRECTORY))).toBe(true);
  });
});

describe('the native title detector itself', () => {
  it('reports a title attribute on an intrinsic element', () => {
    const found = scanSource('probe.tsx', [
      'export const Probe = () => (',
      '  <button title="Close">x</button>',
      ');',
    ].join('\n'));
    expect(found.map((site) => [site.line, site.kind, site.tagName, site.marked])).toEqual([[2, 'attribute', 'button', false]]);
  });

  it('reports an SVG title element', () => {
    const found = scanSource('probe.tsx', [
      'export const Probe = () => (',
      '  <svg><title>Running</title></svg>',
      ');',
    ].join('\n'));
    expect(found.map((site) => site.kind)).toEqual(['svg-title']);
  });

  it('reports an object literal spread that carries title', () => {
    const found = scanSource('probe.tsx', [
      'export const Probe = () => (',
      "  <span {...{ title: 'Why' }} />",
      ');',
    ].join('\n'));
    expect(found.map((site) => site.kind)).toEqual(['spread']);
  });

  it('ignores a component prop named title and title in plain object data', () => {
    const found = scanSource('probe.tsx', [
      "const columns = [{ title: 'Name' }];",
      'export const Probe = () => (',
      '  <ConfirmDialog title="Delete task" message={columns.length} />',
      ');',
    ].join('\n'));
    expect(found).toEqual([]);
  });

  it('reads a marker above a multi-line opening tag, with its reason', () => {
    const found = scanSource('probe.tsx', [
      'export const Probe = () => (',
      '  // native-title-ok: full value of the truncated path',
      '  <span',
      '    className="truncate"',
      '    title={path}',
      '  >{path}</span>',
      ');',
    ].join('\n'));
    expect(found.map((site) => [site.marked, site.reason])).toEqual([[true, 'full value of the truncated path']]);
  });

  it('reads a JSX comment marker inside the opening tag', () => {
    const found = scanSource('probe.tsx', [
      'export const Probe = () => (',
      '  <span',
      '    className="truncate"',
      '    // native-title-ok: full value of the branch name',
      '    title={branch}',
      '  >{branch}</span>',
      ');',
    ].join('\n'));
    expect(found.map((site) => [site.marked, site.reason])).toEqual([[true, 'full value of the branch name']]);
  });

  it('does not count a bare marker with no reason', () => {
    const found = scanSource('probe.tsx', [
      'export const Probe = () => (',
      '  // native-title-ok:',
      '  <span title="Why">x</span>',
      ');',
    ].join('\n'));
    expect(found.map((site) => site.marked)).toEqual([false]);
  });

  it('keeps a marker with the wrong reason marked, so the reason check can fail it', () => {
    const found = scanSource('probe.tsx', [
      'export const Probe = () => (',
      '  // native-title-ok: explains the button',
      '  <span title="Why">x</span>',
      ');',
    ].join('\n'));
    expect(found.map((site) => [site.marked, site.reason.startsWith(REASON_PREFIX)])).toEqual([[true, false]]);
  });
});
