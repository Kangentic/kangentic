/**
 * Each surface of the main window sits inside a boundary of its own, so one
 * render throw costs that surface and not the window. Without one it falls to
 * the root `ErrorBoundary`, which unmounts every terminal and every Browser pane
 * guest the app holds. A refactor that moves a surface out of its boundary
 * passes every other check, so this pins each one at its JSX.
 *
 * The unit tier has no DOM to render AppLayout in, and React's own boundary
 * behaviour is not ours to test, so the pin reads the source.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.join(__dirname, '../..');
const read = (relative: string): string => fs.readFileSync(path.join(repoRoot, relative), 'utf8');

describe('main window surfaces each have their own boundary', () => {
  const layout = read('src/renderer/components/layout/AppLayout.tsx');

  it.each([
    ['title-bar', 'TitleBar'],
    ['sidebar', 'ProjectSidebar'],
    ['board', 'KanbanBoard'],
    ['terminal-panel', 'TerminalPanel'],
    ['backlog', 'BacklogView'],
    ['status-bar', 'StatusBar'],
    ['settings', 'SettingsPanel'],
    ['command-terminal', 'CommandTerminalLayer'],
    ['search', 'SearchPalette'],
  ])('%s wraps <%s>', (surface, component) => {
    const pattern = new RegExp(`<SurfaceBoundary surface="${surface}"[^\\n]*>\\s*<${component}[\\s/>]`);
    expect(layout).toMatch(pattern);
  });

  it('names every surface it declares, and each has a translated failure line', () => {
    const boundary = read('src/renderer/components/layout/SurfaceBoundary.tsx');
    const declared = [...boundary.matchAll(/^\s+'?([a-z-]+)'?: \{ panel: '[^']+', layout: '(?:fill|bar|overlay)', message: msg`[^`]+` \},$/gm)].map((match) => match[1]);
    const used = [...layout.matchAll(/<SurfaceBoundary surface="([a-z-]+)"/g)].map((match) => match[1]);
    expect(new Set(used)).toEqual(new Set(declared));
  });

  it('gives a task window one too, always present so a dormant window keeps its tree', () => {
    const content = read('src/renderer/window-manager/components/WindowContent.tsx');
    expect(content).toMatch(/<PanelErrorBoundary panel="Task detail" message=\{t`Failed to load this task`\}>\s*<TaskDetailContent/);
  });
});
