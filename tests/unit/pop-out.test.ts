/**
 * Unit tests for the pop-out window engine's shared descriptor contract
 * (src/shared/pop-out.ts): popOutInstanceKey and isPopOutKind. Both processes
 * (main's window registry and the renderer's pop-out store) rely on
 * popOutInstanceKey to agree on instance identity -- a drift here would let a
 * second task's pop-out collide with the first's, or a global surface fail to
 * collapse to a single key.
 */
import { describe, it, expect } from 'vitest';
import { popOutInstanceKey, isPopOutKind, POP_OUT_SURFACES, POPOUT_KINDS } from '../../src/shared/pop-out';
import { IPC } from '../../src/shared/ipc-channels';

describe('popOutInstanceKey', () => {
  it('collapses the global "stats" surface to its bare kind, ignoring any params', () => {
    expect(popOutInstanceKey('stats', {})).toBe('stats');
  });

  it('collapses the global "monitor" surface to its bare kind', () => {
    expect(popOutInstanceKey('monitor', {})).toBe('monitor');
  });

  /**
   * The specific regression this guards: the global branch used to be a hardcoded
   * `kind === 'stats'` check, so a SECOND global surface fell through to the
   * task-params branch and keyed as `monitor:undefined:undefined`. That key still
   * looks plausible and is stable, so the window would open and track - it would
   * simply never match the renderer's own lookup. Assert every declared global
   * surface collapses, rather than spot-checking the two that exist today.
   */
  it('every global-scope surface collapses to its bare kind', () => {
    const globalKinds = POPOUT_KINDS.filter((kind) => POP_OUT_SURFACES[kind].scope === 'global');
    expect(globalKinds.length).toBeGreaterThan(1);
    for (const kind of globalKinds) {
      expect(popOutInstanceKey(kind, {} as never)).toBe(kind);
    }
  });
});

describe('POP_OUT_SURFACES fan-out declarations', () => {
  /**
   * A channel a surface subscribes to but does not declare here is dropped
   * SILENTLY for pop-out windows (windowsForChannel filters on this list), so the
   * detached surface just never updates. These pin the monitor's two live wires.
   */
  it('the monitor declares the channels its surface subscribes to', () => {
    const channels = POP_OUT_SURFACES.monitor.channels;
    expect(channels).toContain(IPC.MONITOR_CHANGED);
    expect(channels).toContain(IPC.SESSION_ACTIVITY);
    expect(channels).toContain(IPC.CONFIG_CHANGED);
  });

  it('the monitor is a global surface with no task params', () => {
    expect(POP_OUT_SURFACES.monitor.scope).toBe('global');
    expect(POP_OUT_SURFACES.monitor.needsWebview).toBe(false);
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
