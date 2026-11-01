import { describe, it, expect } from 'vitest';
import { resolveShortcutCommand } from '../../src/shared/template-vars';

describe('resolveShortcutCommand', () => {
  const context = {
    cwd: '/home/user/project/.kangentic/worktrees/feature-branch',
    branchName: 'feature/auth-login',
    taskTitle: 'Implement auth login',
    projectPath: '/home/user/project',
  };

  it('replaces {{cwd}}', () => {
    expect(resolveShortcutCommand('code "{{cwd}}"', context))
      .toBe('code "/home/user/project/.kangentic/worktrees/feature-branch"');
  });

  it('replaces {{branchName}}', () => {
    expect(resolveShortcutCommand('git checkout {{branchName}}', context))
      .toBe('git checkout feature/auth-login');
  });

  it('replaces {{taskTitle}}', () => {
    expect(resolveShortcutCommand('echo "{{taskTitle}}"', context))
      .toBe('echo "Implement auth login"');
  });

  it('replaces {{projectPath}}', () => {
    expect(resolveShortcutCommand('open {{projectPath}}', context))
      .toBe('open /home/user/project');
  });

  it('replaces multiple variables in one template', () => {
    expect(resolveShortcutCommand('cd "{{cwd}}" && echo "{{taskTitle}}" on {{branchName}}', context))
      .toBe('cd "/home/user/project/.kangentic/worktrees/feature-branch" && echo "Implement auth login" on feature/auth-login');
  });

  it('replaces duplicate variables', () => {
    expect(resolveShortcutCommand('{{cwd}} {{cwd}}', context))
      .toBe('/home/user/project/.kangentic/worktrees/feature-branch /home/user/project/.kangentic/worktrees/feature-branch');
  });

  it('returns template unchanged when no variables match', () => {
    expect(resolveShortcutCommand('echo hello', context))
      .toBe('echo hello');
  });

  it('handles empty context values', () => {
    const emptyContext = { cwd: '', branchName: '', taskTitle: '', projectPath: '' };
    expect(resolveShortcutCommand('code "{{cwd}}"', emptyContext))
      .toBe('code ""');
  });

  it('handles Windows paths', () => {
    const windowsContext = {
      cwd: 'C:\\Users\\dev\\project\\.kangentic\\worktrees\\feature',
      branchName: 'feature/auth',
      taskTitle: 'Auth feature',
      projectPath: 'C:\\Users\\dev\\project',
    };
    expect(resolveShortcutCommand('code "{{cwd}}"', windowsContext))
      .toBe('code "C:\\Users\\dev\\project\\.kangentic\\worktrees\\feature"');
  });

  it('sanitizes shell metacharacters in task title', () => {
    const specialContext = { ...context, taskTitle: 'Fix "quotes" & <angles>' };
    expect(resolveShortcutCommand('echo "{{taskTitle}}"', specialContext))
      .toBe('echo "Fix quotes  angles"');
  });

  it('strips injection attempts from task title', () => {
    const maliciousContext = { ...context, taskTitle: '"; rm -rf /; echo "' };
    const result = resolveShortcutCommand('echo "{{taskTitle}}"', maliciousContext);
    // Semicolons and quotes from the title are stripped; command cannot break out
    expect(result).not.toContain(';');
    expect(result).toBe('echo " rm -rf / echo "');
  });

  it('strips shell metacharacters from a branch name, which a cloned repo can carry', () => {
    // Git allows `;`, `$`, `&` and backticks in a ref name, so a branch is not a
    // controlled source the way the paths are.
    const branchContext = { ...context, branchName: 'feature/x;touch${IFS}pwned&`id`' };
    expect(resolveShortcutCommand('git log {{branchName}}', branchContext))
      .toBe('git log feature/xtouchIFSpwnedid');
  });
});
