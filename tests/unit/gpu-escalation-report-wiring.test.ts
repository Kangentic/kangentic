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
  // lastIndexOf, not indexOf: there are TWO reads on purpose. The first is
  // the module-scope graphics decision (resolveGraphicsMode), which only
  // peeks at the record to decide whether to start Chromium in software
  // rendering and never clears anything - it has to run before whenReady
  // because app.disableHardwareAcceleration() throws after. The REPORT
  // path, which owns the clear, is the later one. `reportPathIsTheLaterRead`
  // below pins that ordering so this anchor cannot silently pick the wrong
  // block if the two are ever reordered.
  const readIndex = INDEX_SOURCE.lastIndexOf('readPendingGpuEscalation(GPU_HEALTH_FILE_PATH)');
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
    // Prefix match, no closing paren: the clear now takes an `onlyIfLastAt`
    // option (compare-and-clear, so a crash loop writing a fresh record
    // between the read and the clear does not lose it). The invariant this
    // pins is "clears, via the one shared constant, before reporting" - the
    // argument list is not part of that, and freezing it only breaks the
    // test on changes it does not care about.
    expect(tryBlock, 'the try block must clear the pending escalation').toContain('clearGpuEscalation(GPU_HEALTH_FILE_PATH');
    expect(tryBlock, 'the try block must report the escalation').toContain('reportHandledError(');

    const clearIndex = tryBlock.indexOf('clearGpuEscalation(GPU_HEALTH_FILE_PATH');
    const reportIndex = tryBlock.indexOf('reportHandledError(');
    expect(
      clearIndex,
      "clearGpuEscalation must run BEFORE reportHandledError: the block's own comment calls this ordering intentional, so a run with error reporting off (the kill switch, or KANGENTIC_ERROR_REPORTING=0) still consumes the record instead of re-queuing it for a later launch that might have reporting on",
    ).toBeLessThan(reportIndex);

    // The try block alone does not prove startup is protected - it has to be
    // followed by a catch, not left to propagate. Whatever immediately
    // follows the try block's own closing brace must open a catch.
    const readIndex = INDEX_SOURCE.lastIndexOf('readPendingGpuEscalation(GPU_HEALTH_FILE_PATH)');
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

  it('reportPathIsTheLaterRead: the module-scope graphics peek comes first and never clears', () => {
    // Every anchor in this file uses lastIndexOf to find the REPORT path,
    // which is only correct while the peek precedes it. If the two are ever
    // reordered, the slicer would silently scan the wrong block and most of
    // this file would pass vacuously.
    const reads = INDEX_CODE.split('readPendingGpuEscalation(GPU_HEALTH_FILE_PATH)').length - 1;
    expect(
      reads,
      'src/main/index.ts should hold exactly two reads of the escalation record: the module-scope graphics decision (peek only) and the whenReady report (which owns the clear)',
    ).toBe(2);

    const firstRead = INDEX_CODE.indexOf('readPendingGpuEscalation(GPU_HEALTH_FILE_PATH)');
    const clearIndex = INDEX_CODE.indexOf('clearGpuEscalation(GPU_HEALTH_FILE_PATH');
    expect(
      clearIndex,
      'the clear must belong to the LATER read. The module-scope peek runs before app.whenReady() and before the window exists; clearing there would consume a record nothing has reported yet',
    ).toBeGreaterThan(firstRead);
  });

  it(
    'arms pendingGpuNotice at MODULE SCOPE, before the whenReady createWindow() call, not only later inside the report block (source-anchor guard against the render race - not a runtime test, index.ts cannot be imported)',
    () => {
      // The renderer can pull IPC.GPU_HEALTH_STATUS as soon as the synchronous
      // createWindow() span below ends, and that handler CONSUMES
      // pendingGpuNotice on read (see the 'registers the graphics-status
      // handler' test above, which pins the consume-on-read clear). The
      // report block that would otherwise be the first to arm this notice
      // sits behind createWindow() and an await (resolveClientId) further
      // down in whenReady, so a renderer that got its GPU_HEALTH_STATUS pull
      // in first would read noticePending: false, consume it, and never ask
      // again, while the escalation record behind it is cleared moments
      // later - leaving the user on software rendering with no explanation.
      // The fix arms the flag at module scope, before any renderer can exist,
      // independent of who wins that race. This is a static source-position
      // check, the same constraint as every other test in this file (index.ts
      // makes top-level electron calls and cannot be imported into vitest).
      const armingIndex = INDEX_CODE.indexOf('if (graphicsMode.engagedNow) pendingGpuNotice = true;');
      expect(
        armingIndex,
        'src/main/index.ts must arm pendingGpuNotice at module scope with `if (graphicsMode.engagedNow) pendingGpuNotice = true;`, independent of the later whenReady report block',
      ).toBeGreaterThan(-1);

      // Anchored on the LAST createWindow() call before the report block's
      // own escalation read (the later of the two reads - see
      // reportPathIsTheLaterRead above), which is the whenReady createWindow()
      // call the module's own comment discusses, not the unrelated
      // rebuildMainWindow() call used only by the macOS 'activate' /
      // 'second-instance' paths.
      const reportReadIndex = INDEX_CODE.lastIndexOf('readPendingGpuEscalation(GPU_HEALTH_FILE_PATH)');
      const createWindowIndex = INDEX_CODE.lastIndexOf('createWindow()', reportReadIndex);
      expect(
        createWindowIndex,
        'src/main/index.ts must still call createWindow() in whenReady before reading the escalation record for the report',
      ).toBeGreaterThan(-1);

      expect(
        armingIndex,
        'pendingGpuNotice must be armed BEFORE this createWindow() call. If the arming line is removed from module scope, or moved back to sit after createWindow() (inside the report block further down, where it used to live), a renderer that pulls GPU_HEALTH_STATUS before the report block runs consumes noticePending: false and never asks again, silently losing the notice',
      ).toBeLessThan(createWindowIndex);
    },
  );

  it("guards against consuming a record THIS run wrote, between the read and the clear", () => {
    const tryBlock = escalationReportTryBlock();
    const guardIndex = tryBlock.indexOf('isEscalationFromCurrentRun');
    const clearIndex = tryBlock.indexOf('clearGpuEscalation(GPU_HEALTH_FILE_PATH');

    expect(
      guardIndex,
      'the report block must call isEscalationFromCurrentRun. The writer is installed at module scope and this block runs after createWindow and an await, so a GPU crash-looping from startup writes into that gap; without the guard the same run reads, clears and reports it while the async Sentry POST races the LOG(FATAL) about to kill the process, and the next launch finds nothing pending',
    ).toBeGreaterThan(-1);
    expect(
      guardIndex,
      'the same-run guard must run BEFORE the clear, or the record is already gone by the time we decide not to consume it',
    ).toBeLessThan(clearIndex);

    expect(
      tryBlock,
      'the clear must be a compare-and-clear against the lastAt that was actually reported: a crash loop can write a fresh record between the read and the clear, and an unconditional unlink would take it',
    ).toContain('onlyIfLastAt');
  });

  it('registers the graphics-status handler in index.ts, where its state lives', () => {
    // Every handler under ipc/handlers/ reaches CI through a call site in
    // registerAllIpc(), so deleting one breaks a visible import chain. This
    // one is a bare top-level statement with no call site pointing at it, and
    // the UI spec that covers its behaviour runs entirely against the mock -
    // so a deleted real handler would surface only as a swallowed rejection in
    // production, logged as a console warning, with nothing going red.
    expect(
      INDEX_CODE,
      'src/main/index.ts must register the GPU_HEALTH_STATUS handler. It cannot move to ipc/handlers/: it returns index.ts module-scope state (the pre-whenReady graphics decision and the one-shot notice flag), and resolveGraphicsMode must run before app.whenReady() because app.disableHardwareAcceleration() throws after it',
    ).toContain('ipcMain.handle(IPC.GPU_HEALTH_STATUS');

    // Consume-on-read is the property the "fires exactly once" UI assertion
    // rests on, and the mock reproduces it. If main stopped clearing the flag,
    // the mock would still pass while the real app re-toasted on every reload.
    const handlerStart = INDEX_CODE.indexOf('ipcMain.handle(IPC.GPU_HEALTH_STATUS');
    const handlerBody = INDEX_CODE.slice(handlerStart, handlerStart + 400);
    expect(
      handlerBody,
      'the handler must clear pendingGpuNotice as it reads it, or a renderer reload re-toasts the same incident',
    ).toContain('pendingGpuNotice = false');
  });

  it('persists the downgrade through the IPC context config manager, not the module-scope one', () => {
    const tryBlock = escalationReportTryBlock();
    expect(
      tryBlock,
      'the report block must persist graphicsAccelerationEnabled once it engages software rendering',
    ).toContain('graphicsAccelerationEnabled: false');
    // Caught in /preview, and invisible to every other tier: safe mode
    // engaged and toasted correctly, then the setting read 'on' again,
    // because registerAllIpc has already built a SECOND ConfigManager that
    // loaded and cached config.json. Every later write in the app goes
    // through that one, so a save here on windowConfigManager is dropped by
    // the next window-bounds save rewriting the file from the stale cache.
    // The downgrade became a one-shot and the next launch would have gone
    // straight back to hardware and died again.
    expect(
      tryBlock,
      'the save must resolve getOptionalIpcContext()?.configManager first - windowConfigManager alone writes a key the IPC context manager then clobbers',
    ).toContain('getOptionalIpcContext()?.configManager');
  });

  it('reports the escalation only after setErrorReportingUser(clientId) has run, so the install id correlates it with a minidump of the same crash', () => {
    // Uses INDEX_CODE (comment-stripped), not tryBlock/INDEX_SOURCE: the
    // block's own comment narrates "Must run AFTER setErrorReportingUser
    // above", so a raw-source indexOf could bind to that prose instead of
    // the real call and the comparison would pass regardless of the actual
    // call order.
    const setUserIndex = INDEX_CODE.indexOf('setErrorReportingUser(clientId)');
    // lastIndexOf for the same reason as the slicer: the earlier read is the
    // module-scope graphics decision, which reports nothing and legitimately
    // runs long before any Sentry user is set.
    const readIndex = INDEX_CODE.lastIndexOf('readPendingGpuEscalation(GPU_HEALTH_FILE_PATH)');
    expect(setUserIndex, 'src/main/index.ts must still call setErrorReportingUser(clientId)').toBeGreaterThan(-1);
    expect(readIndex, 'src/main/index.ts must still call readPendingGpuEscalation(GPU_HEALTH_FILE_PATH)').toBeGreaterThan(-1);
    expect(
      setUserIndex,
      "setErrorReportingUser(clientId) must run BEFORE the escalation is read/reported - the block's own comment says the install id is what correlates the report with a minidump of the same crash, so reporting before the user is set would send an uncorrelated event",
    ).toBeLessThan(readIndex);
  });

  it("sources escalatedInVersion from the persisted record's own appVersion, not from the reporting run's live app.getVersion()", () => {
    const tryBlock = escalationReportTryBlock();

    expect(
      tryBlock,
      'escalatedInVersion must read pendingGpuEscalation.appVersion - the app version that PRODUCED the escalation, not the one doing the reporting. Confusing the two misattributes a still-crashing build to a version that has since been fixed.',
    ).toContain('escalatedInVersion: pendingGpuEscalation.appVersion');
    expect(
      tryBlock,
      'escalatedInVersion must not be sourced from a live app.getVersion() call - that would silently report the CURRENT (reporting) build instead of the one that actually escalated',
    ).not.toContain('escalatedInVersion: app.getVersion()');
  });

  it('reports a fallback-only record (no GPU death at all, the DESKTOP-W launch-failure shape) under its own message, with its mode changes', () => {
    const tryBlock = escalationReportTryBlock();

    expect(
      tryBlock,
      'the report must branch on pendingGpuEscalation.count > 0. A launch-failure ladder records a fallback with count 0, and "GPU process exited repeatedly (reason hardware-fallback, exit code unknown)" would both misdescribe it and group it into the crash-loop issue, which needs different triage',
    ).toContain('pendingGpuEscalation.count > 0');
    expect(
      tryBlock,
      'the count-0 branch must carry its own message, so Sentry groups the launch-failure shape as a separate issue',
    ).toContain("'GPU left hardware acceleration with no GPU process exit reported'");
    expect(
      tryBlock,
      'the reported Error must be built from the branched message, not a second inline literal that could ignore the branch',
    ).toContain('new Error(gpuReportMessage)');
    expect(
      tryBlock,
      'the gpu_process context must carry modeChanges: on a launch-failure ladder it is the only trace of the incident',
    ).toContain('modeChanges: pendingGpuEscalation.modeChanges');
  });

  it('binds each report message to its OWN arm of the count > 0 ternary, not the other one', () => {
    // The test above checks that both message strings and `count > 0` exist
    // somewhere in the block, independently. That stays green even if the two
    // ternary arms are swapped: a crash loop would then report under the
    // fallback-only message and a launch-failure fallback under the
    // crash-loop message, which is the exact misgrouping this branch exists
    // to prevent (a crash-loop issue and a launch-failure issue need
    // different triage). This test pins the ORDER instead: the crash-loop
    // template must sit between the ternary's `?` and `:`, and the
    // fallback-only string after the `:`.
    const tryBlock = escalationReportTryBlock();

    const conditionIndex = tryBlock.indexOf('pendingGpuEscalation.count > 0');
    expect(conditionIndex, 'the branch must still test pendingGpuEscalation.count > 0').toBeGreaterThan(-1);

    const questionMarkIndex = tryBlock.indexOf('?', conditionIndex);
    expect(questionMarkIndex, 'the count > 0 test must be the condition of a ternary').toBeGreaterThan(-1);

    const colonIndex = tryBlock.indexOf(':', questionMarkIndex);
    expect(colonIndex, 'the ternary must have an else arm').toBeGreaterThan(-1);

    const crashLoopMessageIndex = tryBlock.indexOf('`GPU process exited repeatedly');
    const fallbackMessageIndex = tryBlock.indexOf("'GPU left hardware acceleration with no GPU process exit reported'");
    expect(crashLoopMessageIndex, 'the crash-loop template literal must still exist').toBeGreaterThan(-1);
    expect(fallbackMessageIndex, 'the fallback-only string literal must still exist').toBeGreaterThan(-1);

    expect(
      crashLoopMessageIndex,
      "the crash-loop template ('GPU process exited repeatedly...') must be the THEN arm: it has to sit after the ternary's own ?, not before it",
    ).toBeGreaterThan(questionMarkIndex);
    expect(
      crashLoopMessageIndex,
      "the crash-loop template must sit before the ternary's :, i.e. it is the THEN arm, not the ELSE arm",
    ).toBeLessThan(colonIndex);
    expect(
      fallbackMessageIndex,
      "the fallback-only string ('GPU left hardware acceleration...') must be the ELSE arm: it has to sit after the ternary's :, not before it",
    ).toBeGreaterThan(colonIndex);
  });

  it("sources previousRunExit from previousRunProps.lastRunExit with an 'unknown' fallback, the exact field name and sentinel that already drifted once (commit cf620796)", () => {
    const tryBlock = escalationReportTryBlock();

    expect(
      tryBlock,
      "previousRunExit must read previousRunProps.lastRunExit ?? 'unknown' - this is what lets a report distinguish the DESKTOP-W shape (the escalating run ended in an abrupt process kill) from the DESKTOP-15 shape (Chromium recovered on its own); a wrong field name or a different sentinel silently breaks that distinction without any type error, since previousRunProps is a loosely-typed Record",
    ).toContain("previousRunExit: previousRunProps.lastRunExit ?? 'unknown'");
  });
});

/**
 * resolveGraphicsMode() (the module-scope function that decides, before
 * app.whenReady(), whether this launch runs on software rendering) opens with
 * `if (process.env.NODE_ENV === 'test') return ...`. Every E2E test and
 * /preview run sets NODE_ENV=test, and without this bypass a launch under
 * test would still load config, peek a leftover gpu-health.json escalation
 * record, and peek the previous run's uptime record - inheriting a downgrade
 * from whatever ran before it, matching how `isE2ETest` gates the modal
 * dialogs elsewhere in this file (the function's own doc comment says so).
 * Nothing else in the tree can prove this: resolveGraphicsMode is not
 * exported and index.ts cannot be imported (see the file header), so this is
 * a static source-position check, same constraint as every other test here.
 */
describe('resolveGraphicsMode bypasses its whole decision under NODE_ENV=test', () => {
  it('checks process.env.NODE_ENV === \'test\' inside resolveGraphicsMode\'s own preamble, as an early return before the try block that does the real work', () => {
    const signatureIndex = INDEX_CODE.indexOf('function resolveGraphicsMode()');
    expect(signatureIndex, 'src/main/index.ts must still declare function resolveGraphicsMode()').toBeGreaterThan(-1);

    const tryIndex = INDEX_CODE.indexOf('try {', signatureIndex);
    expect(tryIndex, 'resolveGraphicsMode must still open a try block for its real (non-test) decision path').toBeGreaterThan(-1);

    // Bounded to the PREAMBLE (signature through the function's own try {),
    // not searched from the signature to end of file: process.env.NODE_ENV
    // === 'test' also gates isE2ETest and an unrelated isTest constant
    // further down in this file, and an unbounded indexOf could bind to
    // either of those instead of a check actually inside this function -
    // which is exactly what happened when this test was first written
    // (removing the real check still let it find isE2ETest's declaration).
    const preamble = INDEX_CODE.slice(signatureIndex, tryIndex);
    const bypassIndex = preamble.indexOf("process.env.NODE_ENV === 'test'");
    expect(
      bypassIndex,
      "resolveGraphicsMode must check process.env.NODE_ENV === 'test' before its own try block. Every E2E test (helpers.ts's launchApp()) and /preview run sets NODE_ENV=test; without this check inside the function's own preamble, a test launch would run the real graphics decision and could inherit a downgrade from a leftover gpu-health.json record or a graphicsAccelerationEnabled: false setting written by an earlier run or session",
    ).toBeGreaterThan(-1);

    expect(
      preamble.slice(bypassIndex).indexOf('return'),
      'the NODE_ENV check must be followed by a return - an early-return guard, not merely a condition referenced elsewhere in the function',
    ).toBeGreaterThan(-1);
  });
});
