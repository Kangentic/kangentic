/**
 * A failure toast says "This issue has been automatically reported to
 * Kangentic" when main sent the failure's report (#1188, toast-shape.md). The
 * fact rides the rejected IPC call, so a toast whose body comes from
 * `describeIpcError` must also pass `reported`: by spreading
 * `ipcFailureToastFields(error)`, by setting `reported: ipcErrorWasReported(error)`,
 * or by spreading a helper that returns it (`sessionToggleFailureToast`). A new
 * failure toast that forgets it shows no line for a bug that was reported, and
 * nothing else would notice.
 *
 * The scan reads each `addToast(` / `updateToast(` call with the lines just above
 * it, where a reason is usually computed first. It is a text scan, so a toast
 * built in another function from a reason passed in is out of its reach; those
 * sites take a `reported` argument of their own (`reportFailure` in
 * AppSettingsPanel, `failed` in CommandTerminalRail).
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const RENDERER = path.join(__dirname, '..', '..', 'src', 'renderer');
const LOOKBACK_LINES = 12;
const REPORTED_LINE = 'This issue has been automatically reported to Kangentic';

/**
 * Toast calls whose body comes from `describeIpcError` but that are not a
 * failure main could have reported, each with its reason.
 */
const ALLOWED: Record<string, string> = {};

function rendererFiles(directory: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) rendererFiles(full, out);
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** The text of the call starting at `openIndex` (the `(`), through its matching `)`. */
function callSpan(source: string, openIndex: number): string {
  let depth = 0;
  for (let index = openIndex; index < source.length; index += 1) {
    const character = source[index];
    if (character === '(') depth += 1;
    else if (character === ')') {
      depth -= 1;
      if (depth === 0) return source.slice(openIndex, index + 1);
    }
  }
  return source.slice(openIndex);
}

/** Line comments blanked, so a comment that names `describeIpcError` reads as nothing. */
function withoutLineComments(source: string): string {
  return source.replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

/** `file:line` for every toast call built from an IPC rejection that does not pass `reported`. */
export function findUnreportedToasts(rawSource: string, label: string): string[] {
  const source = withoutLineComments(rawSource);
  const offenders: string[] = [];
  const lines = source.split('\n');
  const callPattern = /\b(addToast|updateToast)\(/g;
  let scannedUpTo = 0;
  let lineNumber = 1;
  for (let match = callPattern.exec(source); match !== null; match = callPattern.exec(source)) {
    const openIndex = match.index + match[0].length - 1;
    const span = callSpan(source, openIndex);
    // Matches arrive in order, so count newlines only since the last one.
    for (let index = scannedUpTo; index < match.index; index += 1) {
      if (source[index] === '\n') lineNumber += 1;
    }
    scannedUpTo = match.index;
    const lookback = lines.slice(Math.max(0, lineNumber - 1 - LOOKBACK_LINES), lineNumber - 1).join('\n');
    const readsRejection = /\bdescribeIpcError\(/.test(span) || /\bdescribeIpcError\(/.test(lookback);
    if (!readsRejection) continue;
    const passesReported = /\breported\b/.test(span) || /\bipcFailureToastFields\(/.test(span) || /\bsessionToggleFailureToast\(/.test(span);
    if (passesReported) continue;
    const site = `${label}:${lineNumber}`;
    if (!ALLOWED[site]) offenders.push(site);
  }
  return offenders;
}

describe('toast reported fields', () => {
  it('every toast built from an IPC rejection passes reported', () => {
    const offenders = rendererFiles(RENDERER).flatMap((file) => {
      const label = path.relative(RENDERER, file).replace(/\\/g, '/');
      return findUnreportedToasts(fs.readFileSync(file, 'utf8'), label);
    }).sort();
    expect(offenders, `Pass reported with ipcFailureToastFields(error) or ipcErrorWasReported(error):\n${offenders.join('\n')}`).toEqual([]);
  });

  it('the reported line is written only by ToastItem', () => {
    const writers = rendererFiles(RENDERER)
      .filter((file) => fs.readFileSync(file, 'utf8').includes(REPORTED_LINE))
      .map((file) => path.relative(RENDERER, file).replace(/\\/g, '/'))
      .sort();
    expect(writers).toEqual(['components/layout/ToastItem.tsx']);
  });

  it('the detector flags a toast that forgets reported, and passes the three ways to pass it', () => {
    const forgot = [
      'try { await save(); } catch (error) {',
      '  const reason = asSentence(describeIpcError(error));',
      "  useToastStore.getState().addToast({ title: 'Couldn\\'t save', message: reason, variant: 'error' });",
      '}',
    ].join('\n');
    expect(findUnreportedToasts(forgot, 'bad.ts')).toEqual(['bad.ts:3']);

    const inline = "addToast({ title: 'x', message: asSentence(describeIpcError(error)), variant: 'error' });";
    expect(findUnreportedToasts(inline, 'inline.ts')).toEqual(['inline.ts:1']);

    expect(findUnreportedToasts("addToast({ title: 'x', ...ipcFailureToastFields(error), variant: 'error' });", 'a.ts')).toEqual([]);
    expect(findUnreportedToasts(forgot.replace('variant:', 'reported: ipcErrorWasReported(error), variant:'), 'b.ts')).toEqual([]);
    expect(findUnreportedToasts("const failed = describeIpcError(error);\naddToast({ ...sessionToggleFailureToast('resume', error) });", 'c.ts')).toEqual([]);
    expect(findUnreportedToasts("addToast({ title: 'Saved', message: 'Done.' });", 'd.ts')).toEqual([]);
  });
});
