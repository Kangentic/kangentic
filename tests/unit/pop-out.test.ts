/**
 * Unit tests for the pop-out window engine's shared descriptor contract
 * (src/shared/pop-out.ts): popOutInstanceKey and isPopOutKind. Both processes
 * (main's window registry and the renderer's pop-out store) rely on
 * popOutInstanceKey to agree on instance identity -- a drift here would let a
 * second task's pop-out collide with the first's, or a global surface fail to
 * collapse to a single key.
 */
import { describe, it, expect } from 'vitest';
import { popOutInstanceKey, isPopOutKind } from '../../src/shared/pop-out';

describe('popOutInstanceKey', () => {
  it('collapses the global "stats" surface to its bare kind, ignoring any params', () => {
    expect(popOutInstanceKey('stats', {})).toBe('stats');
  });

  it('keys a task-scoped "changes" surface by kind:projectId:taskId', () => {
    expect(popOutInstanceKey('changes', { taskId: 't1', projectId: 'p1' })).toBe('changes:p1:t1');
  });

  it('a different taskId yields a distinct "changes" key', () => {
    const first = popOutInstanceKey('changes', { taskId: 't1', projectId: 'p1' });
    const second = popOutInstanceKey('changes', { taskId: 't2', projectId: 'p1' });
    expect(first).not.toBe(second);
  });

  it('a different projectId yields a distinct "changes" key', () => {
    const first = popOutInstanceKey('changes', { taskId: 't1', projectId: 'p1' });
    const second = popOutInstanceKey('changes', { taskId: 't1', projectId: 'p2' });
    expect(first).not.toBe(second);
  });

  it('keys a task-scoped "browser" surface by kind:projectId:taskId', () => {
    expect(popOutInstanceKey('browser', { taskId: 't1', projectId: 'p1' })).toBe('browser:p1:t1');
  });

  it('a different taskId yields a distinct "browser" key', () => {
    const first = popOutInstanceKey('browser', { taskId: 't1', projectId: 'p1' });
    const second = popOutInstanceKey('browser', { taskId: 't2', projectId: 'p1' });
    expect(first).not.toBe(second);
  });

  it('"changes" and "browser" keys never collide for the same task/project', () => {
    const changesKey = popOutInstanceKey('changes', { taskId: 't1', projectId: 'p1' });
    const browserKey = popOutInstanceKey('browser', { taskId: 't1', projectId: 'p1' });
    expect(changesKey).not.toBe(browserKey);
  });
});

describe('isPopOutKind', () => {
  it.each(['stats', 'changes', 'browser'])('accepts "%s" as a valid PopOutKind', (kind) => {
    expect(isPopOutKind(kind)).toBe(true);
  });

  it.each(['', 'unknown', 'Stats', 'task', 'browser2'])('rejects "%s" as not a valid PopOutKind', (value) => {
    expect(isPopOutKind(value)).toBe(false);
  });
});
