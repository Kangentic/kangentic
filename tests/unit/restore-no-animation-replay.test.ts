import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { hasOptOutMarker } from './helpers/opt-out-marker';

// Enforces .claude/rules/restore-no-animation-replay.md (the value-pulse arm). A project
// switch / restore re-points the status and context bars to a different context's numbers;
// that flip is not a live tick and must not pulse. The guard: every `useValuePulse(...)` call
// must pass a `resetKey` identifying the context the value belongs to (project id, session id),
// so the hook rebaselines silently on a context switch instead of animating.
//
// (The window-restore arm of the same rule is locked by window-workspace.test.ts:
// deserializeWorkspace stamps skipEnterAnimation and serializeWorkspace never persists it.)
//
// Escape hatch: a call that genuinely never re-points across a context boundary may carry a
// `// value-pulse-ok: <reason>` marker on the call line or the line above.

const REPO_ROOT = path.resolve(__dirname, '../..');
const SCAN_DIR = 'src/renderer';
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx']);
const OK_MARKER = 'value-pulse-ok';

// The hook's own definition lives here; it is not a call site.
const DEFINITION_FILE = 'src/renderer/hooks/useValuePulse.ts';

function collectSourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectSourceFiles(fullPath));
    } else if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      files.push(fullPath);
    }
  }
  return files;
}

function toPosix(relativePath: string): string {
  return relativePath.replace(/\\/g, '/');
}

/** Extract the balanced-paren argument list of the call starting at `openParenIndex`
 *  (the index of the '(' right after `useValuePulse`). Returns the substring between the
 *  parentheses. Naive paren counting is sufficient for these simple call sites. */
function extractCallArgs(text: string, openParenIndex: number): string {
  let depth = 0;
  for (let i = openParenIndex; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')') {
      depth--;
      if (depth === 0) return text.slice(openParenIndex + 1, i);
    }
  }
  return text.slice(openParenIndex + 1); // unbalanced (should not happen in valid source)
}

function lineNumberAt(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (text[i] === '\n') line++;
  return line;
}

interface ValuePulseCall {
  file: string;
  line: number;
  hasResetKey: boolean;
  suppressed: boolean;
}

// Takes the source text (plus a label) rather than only a path, so the marker
// handling can be driven directly over known input below. Without this, the
// `value-pulse-ok` opt-out's positive path (a marker actually suppressing a
// missing-resetKey call) is exercised only if the live tree happens to carry
// one, which it does not today - a wiring regression here (wrong marker name,
// wrong line index) would report nothing and the whole suite would still pass.
function scanSource(fileLabel: string, text: string): ValuePulseCall[] {
  const lines = text.split('\n');
  const callPattern = /useValuePulse\s*\(/g;
  const found: ValuePulseCall[] = [];

  for (const match of text.matchAll(callPattern)) {
    const openParenIndex = match.index + match[0].length - 1;
    const args = extractCallArgs(text, openParenIndex);
    const callLine = lineNumberAt(text, match.index); // 1-based
    found.push({
      file: fileLabel,
      line: callLine,
      hasResetKey: /resetKey/.test(args),
      suppressed: hasOptOutMarker(lines, callLine - 1, OK_MARKER),
    });
  }
  return found;
}

describe('every useValuePulse call rebaselines on a context change (resetKey)', () => {
  it('no useValuePulse call site in src/renderer omits resetKey', () => {
    const absoluteDir = path.join(REPO_ROOT, SCAN_DIR);
    const offenders = collectSourceFiles(absoluteDir)
      .filter((filePath) => toPosix(path.relative(REPO_ROOT, filePath)) !== DEFINITION_FILE)
      .flatMap((filePath) => {
        const relative = toPosix(path.relative(REPO_ROOT, filePath));
        return scanSource(relative, fs.readFileSync(filePath, 'utf-8'))
          .filter((call) => !call.hasResetKey && !call.suppressed)
          .map((call) => `${call.file}:${call.line}`);
      });

    expect(
      offenders,
      `Every useValuePulse(...) must pass a resetKey identifying the value's context (project id, ` +
        `session id, ...) so a project/session switch rebaselines silently instead of pulsing. ` +
        `See .claude/rules/restore-no-animation-replay.md. For a call that never re-points across a ` +
        `context boundary, add // value-pulse-ok: <reason>.\nOffenders:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });
});

// The test above can stay green while the `value-pulse-ok` opt-out is wired wrong -
// no live marker exercises its positive path today (see the comment on scanSource).
// These drive it over known input instead.
describe('the value-pulse-ok opt-out', () => {
  it('suppresses a marked call with no resetKey', () => {
    const found = scanSource('probe.tsx', [
      '  // value-pulse-ok: this value never re-points across a context boundary.',
      '  const pulse = useValuePulse(value);',
    ].join('\n'));

    expect(found).toEqual([{ file: 'probe.tsx', line: 2, hasResetKey: false, suppressed: true }]);
  });

  it('does not suppress an unmarked call with no resetKey', () => {
    const found = scanSource('probe.tsx', '  const pulse = useValuePulse(value);');

    expect(found).toEqual([{ file: 'probe.tsx', line: 1, hasResetKey: false, suppressed: false }]);
  });

  it('does not suppress a bare marker with no reason after the colon', () => {
    const found = scanSource('probe.tsx', [
      '  // value-pulse-ok:',
      '  const pulse = useValuePulse(value);',
    ].join('\n'));

    expect(found).toEqual([{ file: 'probe.tsx', line: 2, hasResetKey: false, suppressed: false }]);
  });

  it('does not need suppression when resetKey is passed', () => {
    const found = scanSource('probe.tsx', '  const pulse = useValuePulse(value, { resetKey: projectId });');

    expect(found).toEqual([{ file: 'probe.tsx', line: 1, hasResetKey: true, suppressed: false }]);
  });
});
