/**
 * The detector behind tests/unit/error-reporting-coverage.test.ts
 * (.claude/rules/error-reporting.md). It finds every place a caught error
 * lands, a `catch` clause, a `.catch(callback)` or the rejection handler of
 * `.then(onFulfilled, onRejected)`, and decides whether that site says what
 * happened to the error.
 *
 * A site passes when its own body, not counting functions nested inside it:
 * - throws (a rethrow, or a wrapped error),
 * - hands the error on (`reject(...)`, `Promise.reject(...)`),
 * - calls a reporter (REPORTER_FUNCTIONS, a `<name>Reporter.report(...)`, or
 *   the pty host's `handledErrors.report(...)`),
 * - relays a fixed code from a worker (`post({ type: 'handledError', ... })`),
 * - or carries `// report-ok: <reason>` on the catch line or at the top of its
 *   body.
 *
 * A reporter called from a function nested in the catch (a `setTimeout`
 * callback) does not count: it may never run. `console.*` never counts, and
 * neither does `markReported`, which records a report rather than making one.
 *
 * A `.then` rejection handler that is a bare name passes when the name is a
 * reporter or the enclosing promise's own `reject`. A `.then` whose second
 * argument is `undefined` or `null` has no handler and is not a site.
 *
 * Out of reach, by decision: an error passed somewhere as a value
 * (`onFailed(error)`), which the scan cannot follow.
 */
import * as ts from 'typescript';
import { hasOptOutMarker } from './opt-out-marker';

/**
 * Every function that sends a handled error to Sentry, or hands it to code that
 * does. Named one by one rather than matched by a `report` prefix, which would
 * also pass `reportAgeOf` or `reportTitleOf`. The coverage test checks that each
 * one is still declared under src/.
 */
export const REPORTER_FUNCTIONS: readonly string[] = [
  // main: the SDK wrapper and the chokepoint send
  'reportHandledError',
  'reportHandledMessage',
  'sendHandledFailure',
  // main: feature reporters
  'reportLaunchFailure',
  'reportPreflightFailure',
  'reportSessionLaunchFailure',
  'reportPtyPortFailure',
  'reportMoveSpawnFailure',
  'reportRecoveryPassFailure',
  'reportTaskReapFailure',
  'reportSyncWriteFailure',
  'reportStopScriptFailure',
  'reportWorktreeRemovalFailure',
  'reportRetrievalWorkerFailure',
  'reportEmbedInitFailure',
  'reportDictationFailure',
  'reportPrepareFailure',
  'reportBackgroundSetupFailure',
  'reportPtyHostHandledError',
  'reportAccountProblem',
  'reportProblem',
  // main: a workflow command's answer for a failure, which reports a defect
  // before it turns it into `{ success: false }` (workflow-commands.ts)
  'reportWorkflowCommandFailure',
  // main: the card's "could not start" notice, which reports every step but
  // `agent` through reportPreflightFailure; an `agent` step's callers report first
  'notifySpawnBlocked',
  // main: a provider CLI read's empty branch, which reports what the CLI never
  // said (output that will not parse, a throw of the client's own)
  'reportUnclassifiedDefect',
  // renderer
  'reportRendererFailure',
  'reportHandledRendererError',
  // renderer: toast helpers that also call reportRendererFailure
  'reportWorkflowFailure',
  'reportTaskActionFailure',
];

/** The pass marker, read through the shared reader so a reason is required. */
export const REPORT_OK_MARKER = 'report-ok';

export interface CatchSite {
  file: string;
  line: number;
  kind: 'catch' | '.catch' | '.then';
  reported: boolean;
}

/** `undefined` or `null` in a handler's place: no handler at all. */
function isAbsentHandler(node: ts.Expression): boolean {
  return node.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(node) && node.text === 'undefined');
}

function isNestedFunction(node: ts.Node): boolean {
  return ts.isArrowFunction(node)
    || ts.isFunctionExpression(node)
    || ts.isFunctionDeclaration(node)
    || ts.isMethodDeclaration(node)
    || ts.isClassDeclaration(node)
    || ts.isClassExpression(node);
}

/** The last name in a receiver chain: `this.foo.barReporter` reads `barReporter`. */
function lastNameOf(expression: ts.Expression): string | null {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return null;
}

function isReporterCall(call: ts.CallExpression): boolean {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return REPORTER_FUNCTIONS.includes(callee.text) || callee.text === 'reject';
  if (!ts.isPropertyAccessExpression(callee)) return false;
  const method = callee.name.text;
  if (REPORTER_FUNCTIONS.includes(method)) return true;
  const receiver = lastNameOf(callee.expression);
  if (method === 'reject' && receiver === 'Promise') return true;
  if (method === 'report' && receiver !== null && (/Reporter$/.test(receiver) || receiver === 'handledErrors')) return true;
  return false;
}

/** `post({ type: 'handledError', ... })`: a worker relaying a fixed code to main. */
function isHandledErrorRelay(call: ts.CallExpression): boolean {
  return call.arguments.some((argument) => ts.isObjectLiteralExpression(argument) && argument.properties.some((property) =>
    ts.isPropertyAssignment(property)
    && ts.isIdentifier(property.name) && property.name.text === 'type'
    && ts.isStringLiteral(property.initializer) && property.initializer.text === 'handledError'));
}

/** Whether `body` throws, hands the error on, or reports, outside nested functions. */
function bodyAccounts(body: ts.Node): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (node !== body && isNestedFunction(node)) return;
    if (ts.isThrowStatement(node)) { found = true; return; }
    if (ts.isCallExpression(node) && (isReporterCall(node) || isHandledErrorRelay(node))) { found = true; return; }
    ts.forEachChild(node, visit);
  };
  visit(body);
  return found;
}

function lineOf(sourceFile: ts.SourceFile, position: number): number {
  return sourceFile.getLineAndCharacterOfPosition(position).line;
}

/** The marker on the catch's own line, at the top of its body, or on its closing line. */
function markedAt(sourceFile: ts.SourceFile, lines: string[], siteStart: number, body: ts.Node): boolean {
  const candidates = new Set<number>([lineOf(sourceFile, siteStart), lineOf(sourceFile, body.getStart(sourceFile))]);
  const statements = ts.isBlock(body) ? body.statements : null;
  if (statements && statements.length > 0) candidates.add(lineOf(sourceFile, statements[0].getStart(sourceFile)));
  else candidates.add(lineOf(sourceFile, body.getEnd()));
  for (const line of candidates) if (hasOptOutMarker(lines, line, REPORT_OK_MARKER)) return true;
  return false;
}

/** The marker a `RefusalError` that wraps a caught error carries: why its cause is known. */
export const REFUSAL_WRAP_OK_MARKER = 'refusal-wrap-ok';

export interface RefusalWrapSite {
  file: string;
  line: number;
  marked: boolean;
}

/**
 * Every `new RefusalError(..., { cause })` inside a catch clause.
 *
 * A `RefusalError` is skipped by `isExpectedFailure` before its `cause` is read,
 * so wrapping a caught error in one hides whatever was caught: a `TypeError`
 * inside goes unreported for good. It is right only when the catch classified the
 * error first (one git cause, an abort, a probe whose only failure is the user's
 * folder), and the marker is where that is said. An unclassified error is wrapped
 * in a plain `Error` with `cause`, which `isExpectedFailure` judges by what it wraps.
 */
export function scanRefusalWraps(fileLabel: string, source: string): RefusalWrapSite[] {
  const scriptKind = fileLabel.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(fileLabel, source, ts.ScriptTarget.Latest, true, scriptKind);
  const lines = source.split('\n');
  const sites: RefusalWrapSite[] = [];

  const carriesCause = (argument: ts.Expression): boolean =>
    ts.isObjectLiteralExpression(argument) && argument.properties.some((property) =>
      (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property))
      && ts.isIdentifier(property.name) && property.name.text === 'cause');

  const visit = (node: ts.Node, insideCatch: boolean): void => {
    const nowInsideCatch = insideCatch || ts.isCatchClause(node);
    if (
      nowInsideCatch
      && ts.isNewExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === 'RefusalError'
      && (node.arguments ?? []).some(carriesCause)
    ) {
      const line = lineOf(sourceFile, node.getStart(sourceFile));
      sites.push({ file: fileLabel, line: line + 1, marked: hasOptOutMarker(lines, line, REFUSAL_WRAP_OK_MARKER) });
    }
    ts.forEachChild(node, (child) => visit(child, nowInsideCatch));
  };

  visit(sourceFile, false);
  return sites;
}

export function scanCatchSites(fileLabel: string, source: string): CatchSite[] {
  const scriptKind = fileLabel.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(fileLabel, source, ts.ScriptTarget.Latest, true, scriptKind);
  const lines = source.split('\n');
  const sites: CatchSite[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isCatchClause(node)) {
      const reported = bodyAccounts(node.block) || markedAt(sourceFile, lines, node.getStart(sourceFile), node.block);
      sites.push({ file: fileLabel, line: lineOf(sourceFile, node.getStart(sourceFile)) + 1, kind: 'catch', reported });
    } else if (
      ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === 'catch'
      && node.arguments.length === 1
    ) {
      const handler = node.arguments[0];
      const callLine = lineOf(sourceFile, node.expression.name.getStart(sourceFile));
      let reported: boolean;
      if (ts.isArrowFunction(handler) || ts.isFunctionExpression(handler)) {
        reported = bodyAccounts(handler.body) || markedAt(sourceFile, lines, node.expression.name.getStart(sourceFile), handler.body);
      } else {
        const name = lastNameOf(handler);
        reported = (name !== null && REPORTER_FUNCTIONS.includes(name)) || hasOptOutMarker(lines, callLine, REPORT_OK_MARKER);
      }
      sites.push({ file: fileLabel, line: callLine + 1, kind: '.catch', reported });
    } else if (
      ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === 'then'
      && node.arguments.length === 2
      && !isAbsentHandler(node.arguments[1])
    ) {
      // `.then(onFulfilled, onRejected)`: the second argument is a catch by
      // another spelling. Located at the handler, where its marker goes.
      const handler = node.arguments[1];
      const handlerStart = handler.getStart(sourceFile);
      const handlerLine = lineOf(sourceFile, handlerStart);
      let reported: boolean;
      if (ts.isArrowFunction(handler) || ts.isFunctionExpression(handler)) {
        reported = bodyAccounts(handler.body) || markedAt(sourceFile, lines, handlerStart, handler.body);
      } else {
        // A named handler: a reporter, the enclosing promise's own `reject`
        // (the error is handed on), or a marker on its line.
        const name = lastNameOf(handler);
        reported = (name !== null && (REPORTER_FUNCTIONS.includes(name) || name === 'reject'))
          || hasOptOutMarker(lines, handlerLine, REPORT_OK_MARKER);
      }
      sites.push({ file: fileLabel, line: handlerLine + 1, kind: '.then', reported });
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return sites;
}
