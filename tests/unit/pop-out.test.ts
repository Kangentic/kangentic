/**
 * Unit tests for the pop-out window engine's shared descriptor contract
 * (src/shared/pop-out.ts): popOutInstanceKey and isPopOutKind. Both processes
 * (main's window registry and the renderer's pop-out store) rely on
 * popOutInstanceKey to agree on instance identity -- a drift here would let a
 * second task's pop-out collide with the first's, or a global surface fail to
 * collapse to a single key.
 */
import { describe, it, expect } from 'vitest';
import { popOutInstanceKey, isPopOutKind, resolveSurfaceTitle, formatTaskAnchor, POP_OUT_SURFACES, POPOUT_KINDS } from '../../src/shared/pop-out';
import { IPC } from '../../src/shared/ipc-channels';

describe('POPOUT_KINDS / POP_OUT_SURFACES parity', () => {
  /**
   * POPOUT_KINDS is a plain array annotation, NOT exhaustiveness-checked by the
   * compiler: a kind added to the union and POP_OUT_SURFACES but forgotten here
   * compiles clean, isPopOutKind() then rejects it, and readPopOutDescriptor()
   * falls through - the pop-out window silently mounts the full <App/> instead
   * of its surface. This assertion is what makes the omission loud.
   */
  it('POPOUT_KINDS lists exactly the kinds POP_OUT_SURFACES declares', () => {
    expect([...POPOUT_KINDS].sort()).toEqual(Object.keys(POP_OUT_SURFACES).sort());
  });
});

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
   * detached surface just never updates. These pin the monitor's live
   * wires - MONITOR_PEEK included, even though (unlike the others) it is
   * subscribe-gated rather than an unconditional push: the detached window
   * subscribes on its own behalf, so main is already fanning to it by the time
   * rows exist, and dropping this line would silently freeze every card's
   * output peek in a detached monitor.
   */
  it('the monitor declares the channels its surface subscribes to', () => {
    const channels = POP_OUT_SURFACES.monitor.channels;
    expect(channels).toContain(IPC.MONITOR_CHANGED);
    expect(channels).toContain(IPC.SESSION_ACTIVITY);
    expect(channels).toContain(IPC.MONITOR_PEEK);
    expect(channels).toContain(IPC.CONFIG_CHANGED);
  });

  /**
   * The monitor is currently the ONLY pop-out surface that can host a task
   * detail (and therefore a live terminal) for a project the board is not on
   * (see the channels comment in src/shared/pop-out.ts). Without this channel
   * declared, a PTY reshaped under that detached terminal would never receive
   * the width-drift self-heal's echo (windowsForChannel filters the broadcast
   * on this list) and the divergence would never recover in that window -
   * silently, since nothing else observes the drop. If a future surface also
   * hosts a terminal, extend this assertion to it too.
   */
  it('the monitor declares the PTY-dims echo so a hosted terminal can self-heal a width divergence', () => {
    const channels = POP_OUT_SURFACES.monitor.channels;
    expect(channels).toContain(IPC.SESSION_PTY_RESIZED);
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

describe('the per-file "changes-file" surface', () => {
  it('keys by kind:projectId:taskId:filePath, with the slash-bearing path as the LAST segment', () => {
    expect(popOutInstanceKey('changes-file', { taskId: 't1', projectId: 'p1', filePath: 'src/a/b.ts' }))
      .toBe('changes-file:p1:t1:src/a/b.ts');
  });

  it('a different filePath yields a distinct key (one window per file)', () => {
    const first = popOutInstanceKey('changes-file', { taskId: 't1', projectId: 'p1', filePath: 'a.ts' });
    const second = popOutInstanceKey('changes-file', { taskId: 't1', projectId: 'p1', filePath: 'b.ts' });
    expect(first).not.toBe(second);
  });

  /**
   * scope/commitOid are deliberately NOT in the key: re-opening the same file
   * from another scope (or a commit's file list) must FOCUS the existing window
   * rather than spawn a sibling - "one window per file".
   */
  it('the same file keyed from different scope/commit selections yields the SAME key', () => {
    const working = popOutInstanceKey('changes-file', { taskId: 't1', projectId: 'p1', filePath: 'a.ts', scope: 'working' });
    const staged = popOutInstanceKey('changes-file', { taskId: 't1', projectId: 'p1', filePath: 'a.ts', scope: 'staged' });
    const commit = popOutInstanceKey('changes-file', { taskId: 't1', projectId: 'p1', filePath: 'a.ts', commitOid: 'abc123' });
    expect(staged).toBe(working);
    expect(commit).toBe(working);
  });

  it('never collides with the whole-surface "changes" key for the same task/project', () => {
    const changesKey = popOutInstanceKey('changes', { taskId: 't1', projectId: 'p1' });
    const fileKey = popOutInstanceKey('changes-file', { taskId: 't1', projectId: 'p1', filePath: 'a.ts' });
    expect(fileKey).not.toBe(changesKey);
  });

  it('declares a task scope, the diff/config fan-out channels, and no webview', () => {
    const meta = POP_OUT_SURFACES['changes-file'];
    expect(meta.scope).toBe('task');
    expect(meta.needsWebview).toBe(false);
    expect(meta.channels).toContain(IPC.GIT_DIFF_CHANGED);
    expect(meta.channels).toContain(IPC.CONFIG_CHANGED);
  });

  it('declares a window cap (the only multi-window-per-task kind)', () => {
    expect(POP_OUT_SURFACES['changes-file'].maxInstances).toBe(8);
  });

  it('opens maximized out of the box (a diff reads best with the whole screen)', () => {
    expect(POP_OUT_SURFACES['changes-file'].openMaximized).toBe(true);
  });

  it('titles its window "basename - #N task title" via resolveSurfaceTitle', () => {
    const meta = POP_OUT_SURFACES['changes-file'];
    const params = {
      taskId: 't1',
      projectId: 'p1',
      filePath: 'src/a/b.ts',
      projectPath: '/mock/project',
      baseBranch: 'main',
      status: 'M' as const,
      binary: false,
      taskDisplayId: 12,
      taskTitle: 'Fix the parser',
    };
    expect(resolveSurfaceTitle(meta, params)).toBe('b.ts - #12 Fix the parser');
  });

  it('resolveSurfaceTitle falls back to the static title for kinds without a resolver', () => {
    expect(resolveSurfaceTitle(POP_OUT_SURFACES.changes, { taskId: 't1', projectId: 'p1' })).toBe('Changes');
  });
});

describe('formatTaskAnchor', () => {
  /**
   * formatTaskAnchor is the single builder for the "#N task title" anchor
   * shared by resolveTitle's taskbar form (basename prefix, asserted above via
   * resolveSurfaceTitle) and PopOutSurfaceRoot's frame-header form (full-path
   * prefix, src/renderer/pop-out/PopOutSurfaceRoot.tsx) - the whole point of
   * extracting it is that both call sites can never drift apart. Pin its exact
   * output directly so a format change here (a colon, different spacing, a
   * dash) is caught even if a caller's own test happens not to be touched.
   */
  it('formats "#<displayId> <title>" with a single space, no separator punctuation', () => {
    expect(formatTaskAnchor(42, 'Fix the thing')).toBe('#42 Fix the thing');
  });

  it('does not alter or trim the title text', () => {
    expect(formatTaskAnchor(7, '  spaced title  ')).toBe('#7   spaced title  ');
  });
});

describe('isPopOutKind', () => {
  it.each(['stats', 'changes', 'browser', 'changes-file'])('accepts "%s" as a valid PopOutKind', (kind) => {
    expect(isPopOutKind(kind)).toBe(true);
  });

  it.each(['', 'unknown', 'Stats', 'task', 'browser2', 'changesfile'])('rejects "%s" as not a valid PopOutKind', (value) => {
    expect(isPopOutKind(value)).toBe(false);
  });
});
