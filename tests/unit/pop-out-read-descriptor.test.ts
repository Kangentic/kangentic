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
 *     readPopOutDescriptor() decodes it through decodeBase64Utf8, which uses web APIs
 *     only because a sandboxed preload loses `Buffer` in Electron 45. The test loads
 *     that REAL function out of preload.ts (the source is read and the one function is
 *     transpiled and evaluated with `Buffer` shadowed to undefined), so a change to the
 *     shipped decode breaks it. A copy of the decode written into the test would keep
 *     passing after the preload's own decode regressed, for instance to a bare `atob`
 *     that turns a non-ASCII task title into mojibake with no error.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as ts from 'typescript';
import fs from 'node:fs';
import path from 'node:path';
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

/**
 * The preload's real decodeBase64Utf8, lifted out of src/preload/preload.ts. `Buffer` is shadowed to
 * undefined, which is what a sandboxed preload sees on Electron 45, so a decode that reaches for it
 * throws here the way it would there. `atob`, `Uint8Array` and `TextDecoder` are the Node globals,
 * the same web APIs the preload has.
 */
function loadPreloadDecodeBase64Utf8(): (encoded: string) => string {
  const preloadPath = path.resolve(__dirname, '../../src/preload/preload.ts');
  const sourceFile = ts.createSourceFile(preloadPath, fs.readFileSync(preloadPath, 'utf8'), ts.ScriptTarget.Latest, true);
  const declaration = sourceFile.statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === 'decodeBase64Utf8',
  );
  if (!declaration) {
    throw new Error('src/preload/preload.ts no longer declares a top-level decodeBase64Utf8; update this test to the preload\'s new decode.');
  }
  const { outputText } = ts.transpileModule(declaration.getText(sourceFile), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  });
  return new Function('Buffer', `${outputText}\nreturn decodeBase64Utf8;`)(undefined) as (encoded: string) => string;
}

const decodeBase64Utf8 = loadPreloadDecodeBase64Utf8();

/** Mirrors preload.ts's readPopOutDescriptor() around the real decode: prefix filter, then try/catch to null. */
function decodePopOutArg(arg: string): PopOutDescriptor | null {
  if (!arg.startsWith(POPOUT_ARG_PREFIX)) return null;
  try {
    return JSON.parse(decodeBase64Utf8(arg.slice(POPOUT_ARG_PREFIX.length))) as PopOutDescriptor;
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

// The preload's one decode also reads the dev preview's `--kangentic-preview-task-title=` flag, which
// main writes with the same Buffer encode. A task title is free text, so every UTF-8 width is real input.
describe('preload decodeBase64Utf8 (web APIs only) matches the Buffer encode main uses', () => {
  const encode = (text: string): string => Buffer.from(text, 'utf-8').toString('base64');

  it.each([
    ['empty', ''],
    ['ASCII', 'Fix the login redirect'],
    ['2-byte UTF-8', 'café crème'],
    ['3-byte UTF-8', '修复登录'],
    ['4-byte UTF-8 (surrogate pair)', 'ship it 🚀'],
    ['base64 padding of one and two bytes', 'ab'],
  ])('decodes %s text back to the original string', (_label, text) => {
    expect(decodeBase64Utf8(encode(text))).toBe(text);
  });

  it('throws on a non-base64 string, which readPopOutDescriptor catches into null', () => {
    expect(() => decodeBase64Utf8('!!!not-valid-base64!!!')).toThrow();
  });
});
