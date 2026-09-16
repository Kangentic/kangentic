/**
 * The GPU-health escalation report block inside `app.whenReady()` in
 * `src/main/index.ts`. It reads a pending escalation record (written by
 * `gpu-health.ts` once repeated GPU-process deaths cross the threshold in an
 * earlier run), clears it, and reports it via `reportHandledError`.
 *
 * `gpu-health.ts`'s own counting/latch/decay/durable-write contract is
 * covered by `tests/unit/gpu-health.test.ts`; this file only pins that the
 * report block in index.ts reads/clears/reports in the right order, sources
 * its two feature-status values from the right places, cannot disrupt
 * startup on a telemetry-only failure, and reads the escalation path from
 * one shared constant rather than a second independent literal.
 *
 * `src/main/index.ts` makes top-level `electron` calls and cannot be
 * imported by a unit test, so this is a static source scan - the same
 * constraint and approach as `tests/unit/before-quit-drain-wiring.test.ts`
 * and `tests/unit/startup-gate.test.ts`.
 *
 * Tier: Unit.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '../..');
const INDEX_SOURCE = fs.readFileSync(path.join(REPO_ROOT, 'src/main/index.ts'), 'utf-8');

/**
 * index.ts with comment-only lines removed, so a count or containment scan
 * cannot be satisfied by prose that merely discusses the code - index.ts's
 * own comment above `GPU_HEALTH_FILE_PATH` narrates "two independent
 * path.join calls", which would otherwise inflate a literal count below.
 * Copied from tests/unit/startup-gate.test.ts's `INDEX_CODE`, which documents
 * the same JSDoc-body exclusion rationale (a bare `startsWith('*')` would
 * also drop a real code line that happens to start with an asterisk).
 */
const INDEX_CODE = INDEX_SOURCE
  .split('\n')
  .filter((line) => {
    const trimmed = line.trim();
    const isJsDocBody = trimmed === '*' || trimmed.startsWith('* ') || trimmed.startsWith('*/');
    return !trimmed.startsWith('//') && !trimmed.startsWith('/*') && !isJsDocBody;
  })
  .join('\n');

/**
 * Slices from `searchFromIndex` through the matching close brace of the
 * first brace-delimited block at or after it, counting brace depth and
 * skipping quoted strings and `//` / `/* ... *\/` comments. Copied from
 * tests/unit/before-quit-drain-wiring.test.ts, which documents in full why a
 * plain substring search for a closing brace is unsafe here: it can bind to
 * a nested block's own close (an `if`, an object literal) instead of the
 * target region's, silently truncating the scanned region before it reaches
 * the code an assertion actually needs to see.
 */
function sliceBalancedBlock(source: string, searchFromIndex: number): string {
  const openBraceIndex = source.indexOf('{', searchFromIndex);
  if (openBraceIndex === -1) {
    throw new Error('sliceBalancedBlock: no opening brace found at or after searchFromIndex');
  }

  let braceDepth = 0;
  let activeQuoteCharacter: string | null = null;
  for (let characterIndex = openBraceIndex; characterIndex < source.length; characterIndex += 1) {
    const character = source[characterIndex];

    if (activeQuoteCharacter) {
      if (character === '\\') {
        characterIndex += 1; // skip an escaped character, including an escaped quote
      } else if (character === activeQuoteCharacter) {
        activeQuoteCharacter = null;
      }
      continue;
    }

    if (character === '/' && source[characterIndex + 1] === '/') {
      const lineEnd = source.indexOf('\n', characterIndex);
      if (lineEnd === -1) break;
      characterIndex = lineEnd;
      continue;
    }

    if (character === '/' && source[characterIndex + 1] === '*') {
      const commentEnd = source.indexOf('*/', characterIndex + 2);
      if (commentEnd === -1) break;
      characterIndex = commentEnd + 1;
      continue;
    }

    if (character === '"' || character === "'" || character === '`') {
      activeQuoteCharacter = character;
      continue;
    }

    if (character === '{') {
      braceDepth += 1;
    } else if (character === '}') {
      braceDepth -= 1;
      if (braceDepth === 0) {
        return source.slice(searchFromIndex, characterIndex + 1);
      }
    }
  }

  throw new Error('sliceBalancedBlock: unbalanced braces after searchFromIndex');
}

/**
 * The whole try block enclosing the escalation read, found by anchoring on
 * the read call and walking backward to its nearest enclosing `try {`. Used
 * by every test below so they all agree on which region of the file they are
 * scanning.
 */
function escalationReportTryBlock(): string {
  const readIndex = INDEX_SOURCE.indexOf('readPendingGpuEscalation(GPU_HEALTH_FILE_PATH)');
  if (readIndex === -1) {
    throw new Error('src/main/index.ts no longer calls readPendingGpuEscalation(GPU_HEALTH_FILE_PATH)');
  }
  const tryIndex = INDEX_SOURCE.lastIndexOf('try {', readIndex);
  if (tryIndex === -1) {
    throw new Error('the escalation read is not inside a try block');
  }
  return sliceBalancedBlock(INDEX_SOURCE, tryIndex);
}

describe('the GPU-health escalation report is wired into src/main/index.ts', () => {
  it('reads GPU_HEALTH_FILE_PATH from a single shared constant, not two independent literals', () => {
    // Both crash-capture.ts's write path and this read/clear path take the
    // path as a caller-supplied argument, so the ONE place a duplicate
    // literal could reappear is index.ts's own constant declaration site.
    expect(
      INDEX_CODE,
      "src/main/index.ts must declare const GPU_HEALTH_FILE_PATH = path.join(PATHS.configDir, 'gpu-health.json'); as a single module constant that both the crash-capture write path and the whenReady read/clear path share",
    ).toContain("const GPU_HEALTH_FILE_PATH = path.join(PATHS.configDir, 'gpu-health.json');");

    const literalOccurrences = INDEX_CODE.match(/path\.join\(PATHS\.configDir, 'gpu-health\.json'\)/g) ?? [];
    expect(
      literalOccurrences.length,
      "path.join(PATHS.configDir, 'gpu-health.json') must appear exactly once in index.ts (the GPU_HEALTH_FILE_PATH declaration itself). A second independent literal can silently diverge from the first - the exact failure mode this constant was hoisted to prevent, when the file previously carried two separate path.join(...) calls for the same path",
    ).toBe(1);
  });

  it('clears the pending escalation BEFORE reporting it, inside a try/catch that cannot disrupt startup', () => {
    const tryBlock = escalationReportTryBlock();

    expect(tryBlock, 'the try block must read the pending escalation').toContain('readPendingGpuEscalation(GPU_HEALTH_FILE_PATH)');
    expect(tryBlock, 'the try block must clear the pending escalation').toContain('clearGpuEscalation(GPU_HEALTH_FILE_PATH)');
    expect(tryBlock, 'the try block must report the escalation').toContain('reportHandledError(');

    const clearIndex = tryBlock.indexOf('clearGpuEscalation(GPU_HEALTH_FILE_PATH)');
    const reportIndex = tryBlock.indexOf('reportHandledError(');
    expect(
      clearIndex,
      "clearGpuEscalation must run BEFORE reportHandledError: the block's own comment calls this ordering intentional, so a run with error reporting off (the kill switch, or KANGENTIC_ERROR_REPORTING=0) still consumes the record instead of re-queuing it for a later launch that might have reporting on",
    ).toBeLessThan(reportIndex);

    // The try block alone does not prove startup is protected - it has to be
    // followed by a catch, not left to propagate. Whatever immediately
    // follows the try block's own closing brace must open a catch.
    const readIndex = INDEX_SOURCE.indexOf('readPendingGpuEscalation(GPU_HEALTH_FILE_PATH)');
    const tryIndex = INDEX_SOURCE.lastIndexOf('try {', readIndex);
    const afterTry = INDEX_SOURCE.slice(tryIndex + tryBlock.length, tryIndex + tryBlock.length + 40);
    expect(
      afterTry,
      'the try block enclosing the escalation report must be immediately followed by a catch, so a telemetry-only failure here (a corrupt record, a reportHandledError throw) can never disrupt startup',
    ).toMatch(/^\s*catch/);
  });

  it("reports two distinct GPU feature-status reads: the escalating run's persisted state and a live read at report time", () => {
    const tryBlock = escalationReportTryBlock();

    // Pinned as full source expressions, not just the two key names: a
    // collapse that sources BOTH from the live call would keep two
    // differently-named keys in the payload while destroying the distinction
    // the module's own comment says both exist to preserve (a machine that
    // has since recovered vs. one still stuck reads identically to Sentry).
    expect(
      tryBlock,
      "featureStatusAtEscalation must be sourced from the persisted record (pendingGpuEscalation.featureStatus) - Chromium's GPU mode AT THE DEATH that produced the escalation, not a live read taken now",
    ).toContain('featureStatusAtEscalation: pendingGpuEscalation.featureStatus');
    expect(
      tryBlock,
      "featureStatusOnReport must be sourced from a LIVE app.getGPUFeatureStatus() call made at report time, not from the persisted record - the reporting boot's GPU mode may already differ from the escalating run's",
    ).toContain('featureStatusOnReport: app.getGPUFeatureStatus()');
  });
});
