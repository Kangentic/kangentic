/**
 * Unit coverage for the branch-name placeholder `useBranchSettings` hands the
 * New Task dialog and the task-detail edit form
 * (src/renderer/hooks/useBranchSettings.ts, `branchPlaceholder`).
 *
 * The placeholder previews the branch the worktree will get. The auto name used to
 * carry a non-default base as a folder prefix (`develop/<slug>-ab12cd34`), which
 * git cannot store next to a branch named `develop`, so the name now never
 * contains the base: `<slug>-ab12cd34` whatever base the user picks. The preview
 * must match, or the dialog promises a name the spawn will not create.
 *
 * This project's vitest config has no jsdom and no @testing-library, so the REAL
 * hook is rendered once through `react-dom/server` (the pattern
 * worktree-placement.test.ts uses for its ReactNode output). A server render runs
 * every `useState` initializer and `useMemo`, which is all the placeholder
 * depends on, and skips `useEffect`, which only fetches the branch list and the
 * path probe. The two fetch helpers are stubbed out so the hook's import graph
 * stays free of the Zustand project store.
 */
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('../../src/renderer/utils/git-branches', () => ({ fetchGitBranches: vi.fn(async () => []) }));
vi.mock('../../src/renderer/utils/project-probe', () => ({ fetchProjectProbe: vi.fn(async () => null) }));

import {
  useBranchSettings,
  type BranchSettingsState,
  type UseBranchSettingsOptions,
} from '../../src/renderer/hooks/useBranchSettings';

/** Render the hook once and return the state it computed on that first render. */
function renderBranchSettings(overrides: Partial<UseBranchSettingsOptions> & { baseBranch?: string } = {}): BranchSettingsState {
  const { baseBranch = '', ...optionOverrides } = overrides;
  // A holder rather than a bare `let`: the assignment happens inside the component, which
  // TypeScript's flow analysis cannot see from the check below.
  const captured: { state: BranchSettingsState | null } = { state: null };
  function Probe(): null {
    captured.state = useBranchSettings({
      title: 'Fix login bug',
      initial: { baseBranch, customBranchName: '', useWorktree: null },
      worktreesEnabled: true,
      defaultBaseBranch: 'main',
      active: true,
      projectPath: '/mock/project',
      remoteAgent: false,
      ...optionOverrides,
    });
    return null;
  }
  renderToStaticMarkup(React.createElement(Probe));
  if (!captured.state) throw new Error('the hook did not render');
  return captured.state;
}

describe('useBranchSettings branchPlaceholder', () => {
  it('is the unprefixed auto name for the default base', () => {
    expect(renderBranchSettings().branchPlaceholder).toBe('fix-login-bug-ab12cd34');
  });

  it('carries no base-branch prefix when a non-default base is picked', () => {
    const settings = renderBranchSettings({ baseBranch: 'develop' });

    // Premise: the non-default base IS selected, so an unprefixed name below is the
    // rule at work and not a base that never took effect.
    expect(settings.effectiveBaseBranch).toBe('develop');
    expect(settings.baseBranch).toBe('develop');
    expect(settings.branchPlaceholder).toBe('fix-login-bug-ab12cd34');
  });

  it('carries no prefix for a base with a slash either', () => {
    const settings = renderBranchSettings({ baseBranch: 'release/2.0' });

    expect(settings.effectiveBaseBranch).toBe('release/2.0');
    expect(settings.branchPlaceholder).toBe('fix-login-bug-ab12cd34');
  });

  it('carries no prefix when the project default is not main and another base is picked', () => {
    const settings = renderBranchSettings({ baseBranch: 'main', defaultBaseBranch: 'develop' });

    expect(settings.effectiveBaseBranch).toBe('main');
    expect(settings.branchPlaceholder).toBe('fix-login-bug-ab12cd34');
  });

  it('falls back to the task-title slug while the title is empty', () => {
    expect(renderBranchSettings({ title: '   ', baseBranch: 'develop' }).branchPlaceholder).toBe('task-title-ab12cd34');
  });

  it('previews the base branch itself when the task runs in the project folder (no worktree, no new branch)', () => {
    const settings = renderBranchSettings({ baseBranch: 'develop', worktreesEnabled: false });

    expect(settings.effectiveWorktree).toBe(false);
    expect(settings.branchPlaceholder).toBe('develop');
  });

  it('previews the base branch itself when a structural blocker rules the worktree out', () => {
    const settings = renderBranchSettings({ baseBranch: 'develop', remoteAgent: true });

    expect(settings.blocker).toBe('remote-agent');
    expect(settings.branchPlaceholder).toBe('develop');
  });
});
