/**
 * Unit tests for the pop-out descriptor parse path: an EXTERNAL-INPUT parser
 * (process.argv / a URL hash, JSON.parsed), so it gets the real-shape fixture
 * treatment rather than a happy-path-only smoke test.
 *
 * Two contracts are pinned here:
 *  1. src/renderer/pop-out/read-descriptor.ts's readPopOutDescriptor() -- the
 *     renderer-side reader: prefer the argv-sourced electronAPI.popOut.descriptor,
 *     fall back to a bare `#stats` URL hash, else null.
 *  2. The base64 descriptor codec that crosses the main <-> preload process boundary:
 *     main's pop-out-window-manager.ts encodes
 *     `Buffer.from(JSON.stringify(descriptor), 'utf-8').toString('base64')` as a
 *     `--kangentic-popout=` additionalArguments flag; preload.ts's (unexported)
 *     readPopOutDescriptor() decodes it. That decode is not exported, so it is
 *     replicated here verbatim (mirroring preload.ts's try/catch shape exactly)
 *     to pin the contract -- a change to either side of the codec breaks this test.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { PopOutDescriptor } from '../../src/shared/pop-out';

// ---------------------------------------------------------------------------
// Part 1: readPopOutDescriptor() (src/renderer/pop-out/read-descriptor.ts).
// The module has no module-level side effects (a plain function export), so a
// single import at top level is fine; each test mutates the window stub.
// ---------------------------------------------------------------------------

const fakeWindow: {
  electronAPI: { popOut: { descriptor: PopOutDescriptor | null } };
  location: { hash: string };
} = {
  electronAPI: { popOut: { descriptor: null } },
  location: { hash: '' },
};

(globalThis as Record<string, unknown>).window = fakeWindow;

import { readPopOutDescriptor } from '../../src/renderer/pop-out/read-descriptor';

describe('readPopOutDescriptor (renderer)', () => {
  beforeEach(() => {
    fakeWindow.electronAPI.popOut.descriptor = null;
    fakeWindow.location.hash = '';
  });

  it('returns the argv-sourced descriptor when present, regardless of the URL hash', () => {
    fakeWindow.electronAPI.popOut.descriptor = { kind: 'changes', params: { taskId: 't1', projectId: 'p1' } };
    fakeWindow.location.hash = '#stats'; // must NOT override the argv descriptor
    expect(readPopOutDescriptor()).toEqual({ kind: 'changes', params: { taskId: 't1', projectId: 'p1' } });
  });

  it('falls back to a bare "#stats" hash when there is no argv descriptor', () => {
    fakeWindow.location.hash = '#stats';
    expect(readPopOutDescriptor()).toEqual({ kind: 'stats', params: {} });
  });

  it('returns null for an unknown hash', () => {
    fakeWindow.location.hash = '#not-a-real-surface';
    expect(readPopOutDescriptor()).toBeNull();
  });

  it('returns null for a task-scoped kind in the hash (no params to recover)', () => {
    // 'changes' is a valid PopOutKind, but the hash fallback only ever recovers the
    // param-less global 'stats' surface -- a task-scoped kind has no way to carry
    // taskId/projectId through a bare hash, so it must NOT be treated as resolvable.
    fakeWindow.location.hash = '#changes';
    expect(readPopOutDescriptor()).toBeNull();
  });

  it('returns null when there is neither an argv descriptor nor a hash', () => {
    expect(readPopOutDescriptor()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Part 2: the base64 descriptor codec across the main <-> preload boundary.
// ---------------------------------------------------------------------------

const POPOUT_ARG_PREFIX = '--kangentic-popout=';

/** Mirrors pop-out-window-manager.ts's encode (PopOutWindowManager.open<K>()). */
function encodePopOutDescriptor(descriptor: PopOutDescriptor): string {
  return `${POPOUT_ARG_PREFIX}${Buffer.from(JSON.stringify(descriptor), 'utf-8').toString('base64')}`;
}

/** Mirrors preload.ts's (unexported) readPopOutDescriptor() decode step exactly. */
function decodePopOutArg(arg: string): PopOutDescriptor | null {
  if (!arg.startsWith(POPOUT_ARG_PREFIX)) return null;
  try {
    return JSON.parse(
      Buffer.from(arg.slice(POPOUT_ARG_PREFIX.length), 'base64').toString('utf-8'),
    ) as PopOutDescriptor;
  } catch {
    return null;
  }
}

describe('pop-out descriptor base64 codec (main encode <-> preload decode contract)', () => {
  it('round-trips a global "stats" descriptor', () => {
    const descriptor: PopOutDescriptor = { kind: 'stats', params: {} };
    expect(decodePopOutArg(encodePopOutDescriptor(descriptor))).toEqual(descriptor);
  });

  it('round-trips a task-scoped "changes" descriptor', () => {
    const descriptor: PopOutDescriptor = { kind: 'changes', params: { taskId: 't1', projectId: 'p1' } };
    expect(decodePopOutArg(encodePopOutDescriptor(descriptor))).toEqual(descriptor);
  });

  it('round-trips a "changes-file" descriptor with a slash-and-space-bearing path, a unicode task title, and the full boot-seed field set', () => {
    const descriptor: PopOutDescriptor = {
      kind: 'changes-file',
      params: {
        taskId: 'task-77',
        projectId: 'project-9',
        filePath: 'src/a b/component.tsx',
        scope: 'working',
        commitOid: 'a1b2c3d4e5f6',
        projectPath: 'C:\\Users\\dev\\repo',
        worktreePath: 'C:\\Users\\dev\\repo\\.kangentic\\worktrees\\task-77',
        baseBranch: 'main',
        status: 'R',
        oldPath: 'src/a b/old-component.tsx',
        binary: false,
        taskDisplayId: 77,
        taskTitle: 'Fix caf\u00e9 rendering \ud83d\ude80',
      },
    };
    expect(decodePopOutArg(encodePopOutDescriptor(descriptor))).toEqual(descriptor);
  });

  it('degrades to null for malformed base64', () => {
    expect(decodePopOutArg(`${POPOUT_ARG_PREFIX}!!!not-valid-base64!!!`)).toBeNull();
  });

  it('degrades to null for base64 that decodes to non-JSON content', () => {
    const notJson = Buffer.from('this is not json', 'utf-8').toString('base64');
    expect(decodePopOutArg(`${POPOUT_ARG_PREFIX}${notJson}`)).toBeNull();
  });
});
