/**
 * Pins the parts of the installed `@sentry/electron` that the Browser pane crash scrub
 * and the own-window process tag restore (src/main/analytics/native-crash-event.ts) silently
 * depend on.
 *
 * isBrowserGuestCrashEvent decides a native crash belongs to a Browser pane page by reading
 * `tags['event.process']`, which only works if the SDK stamps that tag from the
 * `getRendererName` option (renderer-classification.ts). toBrowserGuestCrashWarning then
 * deletes `contexts.electron` keys by the `crashpad.` prefix and by the name `crashed_url`,
 * which only works if the SDK still writes the dump's annotations and the page URL there.
 * If an SDK bump changed any of that, the scrub would stop matching and the page's URL, its
 * JavaScript stack and its minidump would ship, while every other test (all of which hand-build
 * their events) stayed green. Same trap as the "against the installed @sentry/electron source"
 * blocks in error-reporting-switch.test.ts and foreign-crash-real-client.test.ts.
 *
 * restoreOwnRendererProcessTag rests on a second set of SDK facts. Once getRendererName is set, the
 * SDK's live renderer-crash path stamps a renderer that getRendererName leaves unnamed (every window
 * of ours) as 'unknown' rather than 'renderer', and the restore turns that back into 'renderer' by
 * reading the dump's `process_type` annotation out of `contexts.electron`. It only fires if the SDK
 * still falls back to 'unknown' (a future SDK that falls back to 'renderer' makes the restore dead
 * code to delete), still derives the crashed process's type from that annotation, and still copies
 * annotations under the `crashpad.` prefix next to an `event.environment: 'native'` tag.
 *
 * The integration cannot be driven without Electron: it requires `electron` at load time,
 * starts the crash reporter in setup(), and loads its dumps from disk. So the installed source is
 * parsed instead, and the one decision expression that matters (what `event.process` becomes)
 * is evaluated with our REAL rendererNameForReporting plugged in as `getRendererName`, then the
 * resulting event is run through our REAL scrub.
 *
 * scripts/build.js builds main as CJS with `conditions: ['require']`, so the CJS twin is the one
 * the bundle is expected to carry. Both twins are pinned, so which one ships does not matter.
 *
 * Tier: Unit (vitest, no Electron).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import * as ts from 'typescript';
import type { ErrorEvent } from '@sentry/electron/main';
import {
  BROWSER_GUEST_RENDERER_NAME,
  rendererNameForReporting,
} from '../../src/main/analytics/renderer-classification';
import {
  isBrowserGuestCrashEvent,
  restoreOwnRendererProcessTag,
  toBrowserGuestCrashWarning,
} from '../../src/main/analytics/native-crash-event';

const REPO_ROOT = path.resolve(__dirname, '../..');
const requireFromRepo = createRequire(path.join(REPO_ROOT, 'package.json'));

// ---------------------------------------------------------------------------
// Locating the installed integration, from the package's own exports map.
// ---------------------------------------------------------------------------

interface SentryMainExports {
  require: { default: string };
  import: { default: string };
}

const resolvedMainEntry = requireFromRepo.resolve('@sentry/electron/main');
// `./main` lives directly under the package root in both the CJS and the ESM layout.
const packageRoot = path.resolve(path.dirname(resolvedMainEntry), '..');
const sentryPackageJson = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf-8')) as {
  exports: Record<string, SentryMainExports>;
};
const mainExports = sentryPackageJson.exports['./main'];

function minidumpIntegrationPath(mainEntryRelativePath: string): string {
  return path.join(packageRoot, path.dirname(mainEntryRelativePath), 'integrations', 'sentry-minidump', 'index.js');
}

const INSTALLED_TWINS = [
  { label: 'CJS (exports["./main"].require)', file: minidumpIntegrationPath(mainExports.require.default) },
  { label: 'ESM (exports["./main"].import)', file: minidumpIntegrationPath(mainExports.import.default) },
];

// The prefix our scrub deletes by. Not exported, so it is read from source; an export would be
// a change to src/ made for a test.
function readOurCrashpadPrefix(): string {
  const nativeCrashEventSource = fs.readFileSync(
    path.join(REPO_ROOT, 'src/main/analytics/native-crash-event.ts'),
    'utf-8',
  );
  const match = /const\s+CRASHPAD_ANNOTATION_KEY_PREFIX\s*=\s*'([^']+)'/.exec(nativeCrashEventSource);
  if (!match) {
    throw new Error(
      "could not find `const CRASHPAD_ANNOTATION_KEY_PREFIX = '...'` in src/main/analytics/native-crash-event.ts. If it was renamed or exported, update this pin to read it the new way.",
    );
  }
  return match[1];
}

const OUR_CRASHPAD_PREFIX = readOurCrashpadPrefix();

// ---------------------------------------------------------------------------
// Extractors. Each reads one fact out of an integration's source text and throws
// SdkContractDrift, with the consequence spelled out, when it cannot find it.
// ---------------------------------------------------------------------------

class SdkContractDrift extends Error {}

type RendererNameFunction = (contents: unknown) => string | undefined;

/** Our getRendererName, typed for the SDK's untyped contents argument. */
const classifyForSdk: RendererNameFunction = (contents) =>
  rendererNameForReporting(contents as Parameters<typeof rendererNameForReporting>[0]);

const WEBVIEW_GUEST_CONTENTS = { id: 7, getType: () => 'webview' };
const OWN_WINDOW_CONTENTS = { id: 1, getType: () => 'window' };

function parseJavaScript(sourceText: string): ts.SourceFile {
  return ts.createSourceFile('sentry-minidump.js', sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
}

function visitAll(root: ts.Node, visitor: (node: ts.Node) => void): void {
  visitor(root);
  ts.forEachChild(root, (child) => visitAll(child, visitor));
}

function propertyNameText(name: ts.PropertyName): string | undefined {
  return ts.isIdentifier(name) || ts.isStringLiteralLike(name) ? name.text : undefined;
}

/**
 * The name a node is stored under: `name` for `{ name: <node> }`, and also for the assignment
 * `something.name = <node>`, which is how the SDK writes `event.contexts`.
 */
function slotName(node: ts.Node): string | undefined {
  const parent = node.parent;
  if (!parent) return undefined;
  if (ts.isPropertyAssignment(parent) && parent.initializer === node) return propertyNameText(parent.name);
  if (
    ts.isBinaryExpression(parent) &&
    parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    parent.right === node &&
    ts.isPropertyAccessExpression(parent.left)
  ) {
    return parent.left.name.text;
  }
  return undefined;
}

function propertyValue(literal: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined {
  for (const property of literal.properties) {
    if (ts.isPropertyAssignment(property) && propertyNameText(property.name) === name) return property.initializer;
  }
  return undefined;
}

function propertyNames(literal: ts.ObjectLiteralExpression): string[] {
  const names: string[] = [];
  for (const property of literal.properties) {
    if (ts.isPropertyAssignment(property)) {
      const name = propertyNameText(property.name);
      if (name !== undefined) names.push(name);
    } else if (ts.isShorthandPropertyAssignment(property)) {
      names.push(property.name.text);
    }
  }
  return names;
}

interface RendererCrashContract {
  /** The key the SDK stores the crashed process's name under, in the event's `tags`. */
  tagKey: string;
  /** The tags on that same event whose value is a string literal in the SDK, such as `event.environment`. */
  stringTags: Record<string, string>;
  /** The SDK's own expression for that tag, evaluated with the given inputs. */
  stampFor: (processType: string, getRendererName: RendererNameFunction, contents: unknown) => unknown;
  /** The keys of the `contexts.electron` object the SDK builds on that same renderer-crash event. */
  electronContextKeys: string[];
}

/**
 * Finds the `tags` entry that holds the crashed process's name, defined as the entry whose value
 * is (or is a variable assigned from) an expression that calls `getRendererName(<contents>)`.
 */
function readRendererCrashContract(sourceText: string): RendererCrashContract {
  const sourceFile = parseJavaScript(sourceText);

  const variableInitializers = new Map<string, ts.Expression>();
  const tagAssignments: ts.PropertyAssignment[] = [];
  visitAll(sourceFile, (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      variableInitializers.set(node.name.text, node.initializer);
    }
    if (ts.isPropertyAssignment(node) && ts.isObjectLiteralExpression(node.parent) && slotName(node.parent) === 'tags') {
      tagAssignments.push(node);
    }
  });

  function findRendererNameCall(root: ts.Node): ts.CallExpression | undefined {
    const calls: ts.CallExpression[] = [];
    visitAll(root, (node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'getRendererName' &&
        node.arguments.length === 1 &&
        ts.isIdentifier(node.arguments[0])
      ) {
        calls.push(node);
      }
    });
    return calls[0];
  }

  for (const assignment of tagAssignments) {
    const tagKey = propertyNameText(assignment.name);
    const valueExpression = ts.isIdentifier(assignment.initializer)
      ? variableInitializers.get(assignment.initializer.text)
      : assignment.initializer;
    if (tagKey === undefined || !valueExpression) continue;
    const rendererNameCall = findRendererNameCall(valueExpression);
    if (!rendererNameCall) continue;

    // Evaluate the SDK's own expression. Its free identifiers are the getRendererName option, the
    // contents it is called with, and the crash's process type (`minidumpProcess`), which the
    // expression both compares to 'renderer' and falls back to.
    const contentsName = (rendererNameCall.arguments[0] as ts.Identifier).text;
    const freeNames = new Set<string>();
    visitAll(valueExpression, (node) => {
      if (!ts.isIdentifier(node) || node.text === 'undefined') return;
      const parent = node.parent;
      if (ts.isPropertyAccessExpression(parent) && parent.name === node) return;
      if (ts.isPropertyAssignment(parent) && parent.name === node) return;
      freeNames.add(node.text);
    });
    const processTypeNames = [...freeNames].filter((name) => name !== 'getRendererName' && name !== contentsName);
    if (processTypeNames.length > 1) {
      throw new SdkContractDrift(
        `@sentry/electron's event.process expression now reads ${processTypeNames.join(', ')}, more than the one process-type variable this pin can bind. Rework readRendererCrashContract to evaluate it.`,
      );
    }
    const evaluate = new Function(
      'getRendererName',
      contentsName,
      ...processTypeNames,
      `return (${valueExpression.getText(sourceFile)});`,
    ) as (...args: unknown[]) => unknown;

    const tagsLiteral = assignment.parent as ts.ObjectLiteralExpression;
    const eventLiteral = tagsLiteral.parent.parent;
    const contextsLiteral = ts.isObjectLiteralExpression(eventLiteral) ? propertyValue(eventLiteral, 'contexts') : undefined;
    const electronLiteral =
      contextsLiteral && ts.isObjectLiteralExpression(contextsLiteral) ? propertyValue(contextsLiteral, 'electron') : undefined;
    if (!electronLiteral || !ts.isObjectLiteralExpression(electronLiteral)) {
      throw new SdkContractDrift(
        "@sentry/electron's renderer crash event no longer carries a `contexts.electron` object next to its `tags`. native-crash-event.ts's toBrowserGuestCrashWarning deletes `crashed_url` from there, so the page URL would no longer be found.",
      );
    }

    const stringTags: Record<string, string> = {};
    for (const property of tagsLiteral.properties) {
      if (!ts.isPropertyAssignment(property) || !ts.isStringLiteralLike(property.initializer)) continue;
      const name = propertyNameText(property.name);
      if (name !== undefined) stringTags[name] = property.initializer.text;
    }

    return {
      tagKey,
      stringTags,
      stampFor: (processType, getRendererName, contents) =>
        evaluate(getRendererName, contents, ...processTypeNames.map(() => processType)),
      electronContextKeys: propertyNames(electronLiteral).sort(),
    };
  }

  throw new SdkContractDrift(
    "@sentry/electron no longer stamps event.process from getRendererName(contents) on a renderer crash (no `tags` entry is computed from a getRendererName call). The Browser pane crash scrub in native-crash-event.ts (isBrowserGuestCrashEvent) would stop matching, and a pane page's URL, JavaScript stack and minidump would ship.",
  );
}

/**
 * The literal the SDK puts in front of each Crashpad annotation key, found as the template
 * literal inside `Object.entries(<...>.crashpadAnnotations).reduce(...)`. Also checks that the
 * re-keyed annotations are merged into `contexts.electron`, the only object our scrub walks.
 */
function readCrashpadAnnotationPrefix(sourceText: string): string {
  const sourceFile = parseJavaScript(sourceText);

  const reduceCalls: ts.CallExpression[] = [];
  visitAll(sourceFile, (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'reduce' &&
      /^Object\.entries\([^)]*crashpadAnnotations[^)]*\)$/.test(node.expression.expression.getText(sourceFile))
    ) {
      reduceCalls.push(node);
    }
  });
  const reduceCall = reduceCalls[0];

  const prefixes: string[] = [];
  if (reduceCall) {
    visitAll(reduceCall, (node) => {
      if (ts.isTemplateExpression(node) && node.templateSpans.length === 1 && node.templateSpans[0].literal.text === '') {
        prefixes.push(node.head.text);
      }
    });
  }
  if (!reduceCall || prefixes.length === 0) {
    throw new SdkContractDrift(
      "@sentry/electron no longer re-keys the dump's Crashpad annotations as `<prefix>${key}` through Object.entries(...crashpadAnnotations).reduce(...). native-crash-event.ts deletes `contexts.electron` keys by that prefix, so the annotations, including a guest's JavaScript stack, would survive the scrub.",
    );
  }

  const variableName =
    ts.isVariableDeclaration(reduceCall.parent) && ts.isIdentifier(reduceCall.parent.name)
      ? reduceCall.parent.name.text
      : undefined;
  const mergedIntoElectronContext: boolean[] = [];
  visitAll(sourceFile, (node) => {
    if (!ts.isSpreadAssignment(node)) return;
    const spreadsAnnotations =
      node.expression === reduceCall ||
      (variableName !== undefined && ts.isIdentifier(node.expression) && node.expression.text === variableName);
    if (!spreadsAnnotations) return;
    const electronLiteral = node.parent;
    if (slotName(electronLiteral) !== 'electron') return;
    const contextsLiteral = electronLiteral.parent.parent;
    if (slotName(contextsLiteral) === 'contexts') mergedIntoElectronContext.push(true);
  });
  if (mergedIntoElectronContext.length === 0) {
    throw new SdkContractDrift(
      "@sentry/electron no longer merges the re-keyed Crashpad annotations into `contexts.electron`. native-crash-event.ts only walks that object, so annotations moved elsewhere would survive the Browser pane and foreign crash scrubs.",
    );
  }

  return prefixes[0];
}

interface ProcessTypeDerivation {
  /** The Crashpad annotation the SDK reads the crashed process's type from. */
  annotationKey: string;
  /** The SDK's own expression, run against a dump whose annotations hold the given value under that key. */
  derive: (annotationValue: string) => unknown;
}

/**
 * Finds the variable the SDK initialises from one of the dump's Crashpad annotations
 * (`const minidumpProcess = <dump>.crashpadAnnotations?.process_type?.replace('-process', '')`), the
 * crashed process's type that the renderer path then compares with 'renderer'. Found by shape: the
 * nearest variable declaration, inside the same function, around a property read directly off a
 * `.crashpadAnnotations` object. `Object.entries(<dump>.crashpadAnnotations)` and
 * `crashpadAnnotations['key']` are not that shape, so the annotation re-keying above is not picked up.
 */
function readProcessTypeDerivation(sourceText: string): ProcessTypeDerivation {
  const sourceFile = parseJavaScript(sourceText);

  const candidates: Array<{ initializer: ts.Expression; annotationKey: string; dumpName: string }> = [];
  visitAll(sourceFile, (node) => {
    if (
      !ts.isPropertyAccessExpression(node) ||
      !ts.isPropertyAccessExpression(node.expression) ||
      node.expression.name.text !== 'crashpadAnnotations'
    ) {
      return;
    }
    let dump: ts.Expression = node.expression.expression;
    while (ts.isPropertyAccessExpression(dump)) dump = dump.expression;
    if (!ts.isIdentifier(dump)) return;

    let ancestor: ts.Node | undefined = node.parent;
    while (ancestor && !ts.isVariableDeclaration(ancestor)) {
      if (ts.isFunctionLike(ancestor)) return;
      ancestor = ancestor.parent;
    }
    if (ancestor && ts.isVariableDeclaration(ancestor) && ancestor.initializer) {
      candidates.push({ initializer: ancestor.initializer, annotationKey: node.name.text, dumpName: dump.text });
    }
  });

  const candidate = candidates[0];
  if (!candidate) {
    throw new SdkContractDrift(
      "@sentry/electron no longer derives the crashed process's type from a Crashpad annotation (no variable is initialised from `<dump>.crashpadAnnotations.<key>`). The renderer crash path only calls getRendererName for a 'renderer' type, and native-crash-event.ts's restoreOwnRendererProcessTag reads the same annotation back out of contexts.electron, so both would have to be re-derived against the new SDK.",
    );
  }
  const evaluate = new Function(candidate.dumpName, `return (${candidate.initializer.getText(sourceFile)});`) as (
    dump: unknown,
  ) => unknown;
  return {
    annotationKey: candidate.annotationKey,
    derive: (annotationValue) => evaluate({ crashpadAnnotations: { [candidate.annotationKey]: annotationValue } }),
  };
}

// ---------------------------------------------------------------------------
// Checks. Each returns a list of problems and is empty when the source honors the contract.
// They are shared by the real-source tests and the negative controls below, so a control proves
// the very check the real test runs can go red.
// ---------------------------------------------------------------------------

function asErrorEvent(event: Record<string, unknown>): ErrorEvent {
  return event as unknown as ErrorEvent;
}

type Attempt<Result> = { value: Result } | { drift: string };

/** Runs an extractor, turning its SdkContractDrift into a value so a check can report it as a problem. */
function attempt<Result>(read: () => Result): Attempt<Result> {
  try {
    return { value: read() };
  } catch (error) {
    if (error instanceof SdkContractDrift) return { drift: error.message };
    throw error;
  }
}

function checkProcessTag(sourceText: string): string[] {
  const outcome = attempt(() => readRendererCrashContract(sourceText));
  if ('drift' in outcome) return [outcome.drift];
  const contract = outcome.value;

  const problems: string[] = [];
  const stampedForGuest = contract.stampFor('renderer', classifyForSdk, WEBVIEW_GUEST_CONTENTS);
  if (stampedForGuest !== BROWSER_GUEST_RENDERER_NAME) {
    problems.push(
      `on a renderer crash of a <webview> guest the SDK stamps ${JSON.stringify(stampedForGuest)}, not the ${JSON.stringify(BROWSER_GUEST_RENDERER_NAME)} that getRendererName returned. The name must pass through unchanged.`,
    );
  }
  if (!isBrowserGuestCrashEvent(asErrorEvent({ tags: { [contract.tagKey]: stampedForGuest } }))) {
    problems.push(
      `the SDK stores the crashed process under tags[${JSON.stringify(contract.tagKey)}], but isBrowserGuestCrashEvent reads tags['event.process'], so it would not recognise a Browser pane page's crash.`,
    );
  }

  const stampedForOwnWindow = contract.stampFor('renderer', classifyForSdk, OWN_WINDOW_CONTENTS);
  if (isBrowserGuestCrashEvent(asErrorEvent({ tags: { [contract.tagKey]: stampedForOwnWindow } }))) {
    problems.push(
      `a crash of Kangentic's own window is stamped ${JSON.stringify(stampedForOwnWindow)} and isBrowserGuestCrashEvent takes it for a Browser pane page, which would strip its stack.`,
    );
  }
  return problems;
}

function checkCrashpadPrefix(sourceText: string): string[] {
  const outcome = attempt(() => readCrashpadAnnotationPrefix(sourceText));
  if ('drift' in outcome) return [outcome.drift];
  if (outcome.value !== OUR_CRASHPAD_PREFIX) {
    return [
      `the SDK prefixes Crashpad annotations with ${JSON.stringify(outcome.value)} but native-crash-event.ts's CRASHPAD_ANNOTATION_KEY_PREFIX is ${JSON.stringify(OUR_CRASHPAD_PREFIX)}, so its scrub would delete none of them.`,
    ];
  }
  return [];
}

/**
 * toBrowserGuestCrashWarning deletes `crashed_url` by name and keeps `details`. A renamed key
 * would leak the page URL, and an added one is page data nobody has looked at, so the set is
 * pinned exactly rather than just checked for `crashed_url`.
 */
function checkRendererCrashElectronContext(sourceText: string): string[] {
  const outcome = attempt(() => readRendererCrashContract(sourceText));
  if ('drift' in outcome) return [outcome.drift];
  const { electronContextKeys } = outcome.value;
  if (electronContextKeys.join(',') !== ['crashed_url', 'details'].join(',')) {
    return [
      `the SDK's renderer crash event now builds contexts.electron with [${electronContextKeys.join(', ')}] instead of [crashed_url, details]. toBrowserGuestCrashWarning deletes crashed_url and keeps details; decide what a new or renamed key carries before the scrub is allowed to ignore it.`,
    ];
  }
  return [];
}

/** An event built from the SDK's OWN keys and prefix, run through our real functions. */
function checkScrubEndToEnd(sourceText: string): string[] {
  const contractOutcome = attempt(() => readRendererCrashContract(sourceText));
  if ('drift' in contractOutcome) return [contractOutcome.drift];
  const contract = contractOutcome.value;
  const prefixOutcome = attempt(() => readCrashpadAnnotationPrefix(sourceText));
  if ('drift' in prefixOutcome) return [prefixOutcome.drift];
  const prefix = prefixOutcome.value;

  const electronContext: Record<string, unknown> = {};
  for (const key of contract.electronContextKeys) {
    electronContext[key] = key === 'details' ? { reason: 'oom', exitCode: 0 } : 'https://pane.example.test/dashboard';
  }
  electronContext[`${prefix}ptype`] = 'renderer';
  electronContext[`${prefix}guid`] = 'example-guid';

  const event = asErrorEvent({
    level: 'fatal',
    platform: 'native',
    tags: {
      [contract.tagKey]: contract.stampFor('renderer', classifyForSdk, WEBVIEW_GUEST_CONTENTS),
      'exit.reason': 'oom',
    },
    contexts: { electron: electronContext },
    exception: { values: [{ type: 'OutOfMemoryError', value: 'Renderer reached heap limit' }] },
  });

  if (!isBrowserGuestCrashEvent(event)) {
    return ['an event shaped by the SDK for a <webview> guest crash is not recognised as a Browser pane page crash.'];
  }
  const survivingKeys = Object.keys(toBrowserGuestCrashWarning(event).contexts?.electron ?? {});
  if (survivingKeys.join(',') !== 'details') {
    return [
      `after the Browser pane scrub, contexts.electron still holds [${survivingKeys.join(', ')}] where only [details] should remain. Whatever survives ships with the event.`,
    ];
  }
  return [];
}

/**
 * What the live renderer path stamps for a crash of one of OUR windows, which getRendererName leaves
 * unnamed. restoreOwnRendererProcessTag exists because that is 'unknown'. If the SDK ever falls back
 * to 'renderer' instead, the restore has nothing left to fix.
 */
function checkOwnWindowFallback(sourceText: string): string[] {
  const outcome = attempt(() => readRendererCrashContract(sourceText));
  if ('drift' in outcome) return [outcome.drift];

  const stamped = outcome.value.stampFor('renderer', classifyForSdk, OWN_WINDOW_CONTENTS);
  if (stamped === 'unknown') return [];
  if (stamped === 'renderer') {
    return [
      "the SDK's live renderer crash path now stamps 'renderer' for a renderer that getRendererName leaves unnamed, so Kangentic's own window crashes already carry the tag restoreOwnRendererProcessTag exists to put back. The restore is now a no-op and can be removed: delete it from native-crash-event.ts and its call in filterNativeCrashEvent (error-reporting.ts), along with the tests that cover it and the checks for it in this file.",
    ];
  }
  return [
    `the SDK's live renderer crash path now stamps ${JSON.stringify(stamped)} for a renderer that getRendererName leaves unnamed. restoreOwnRendererProcessTag only repairs 'unknown', so Kangentic's own window crashes would reach Sentry tagged ${JSON.stringify(stamped)}. Decide what the tag should be before the restore is allowed to ignore it.`,
  ];
}

/**
 * restoreOwnRendererProcessTag takes the crash to be a renderer's from the dump's `process_type`
 * annotation, so the SDK has to derive its own process type from that same annotation, and a
 * renderer's has to come out as 'renderer' (the value that makes the SDK call getRendererName at all).
 * The restore also strips a `-process` suffix before comparing, the way the SDK does, so the SDK is
 * checked for the strip as well.
 */
function checkProcessTypeDerivation(sourceText: string): string[] {
  const outcome = attempt(() => readProcessTypeDerivation(sourceText));
  if ('drift' in outcome) return [outcome.drift];
  const { annotationKey, derive } = outcome.value;

  const problems: string[] = [];
  const derivedForRenderer = derive('renderer');
  if (derivedForRenderer !== 'renderer') {
    problems.push(
      `the SDK derives ${JSON.stringify(derivedForRenderer)} from a renderer dump's ${JSON.stringify(annotationKey)} annotation instead of 'renderer'. The renderer crash path only calls getRendererName for 'renderer', so no Browser pane page would be recognised, and restoreOwnRendererProcessTag would no longer see own windows as renderers.`,
    );
  }
  const derivedForGpu = derive('gpu-process');
  if (derivedForGpu !== 'gpu') {
    problems.push(
      `the SDK derives ${JSON.stringify(derivedForGpu)} from the annotation value 'gpu-process' instead of stripping the suffix to 'gpu'. restoreOwnRendererProcessTag strips '-process' before comparing, the way the SDK did, so its strip no longer mirrors the SDK. Review whether it should still strip.`,
    );
  }
  return problems;
}

/**
 * An own-window renderer crash event built from the SDK's OWN names (the annotation key it derives
 * the process type from, the prefix it copies annotations under, the `event.environment` value, the
 * tag key it stamps, and the 'unknown' it stamps by its own fallback), run through our REAL restore.
 * Only the annotation's value ('renderer') and the exit reason are typed in here. The prefix is
 * checkCrashpadPrefix's to pin against native-crash-event.ts's constant. This is what catches the
 * restore's own literals (`process_type`, `event.environment`, `native`, `event.process`) drifting
 * away from what the SDK writes.
 */
function checkRestoreEndToEnd(sourceText: string): string[] {
  const contractOutcome = attempt(() => readRendererCrashContract(sourceText));
  if ('drift' in contractOutcome) return [contractOutcome.drift];
  const contract = contractOutcome.value;
  const prefixOutcome = attempt(() => readCrashpadAnnotationPrefix(sourceText));
  if ('drift' in prefixOutcome) return [prefixOutcome.drift];
  const derivationOutcome = attempt(() => readProcessTypeDerivation(sourceText));
  if ('drift' in derivationOutcome) return [derivationOutcome.drift];
  const derivation = derivationOutcome.value;

  const environment = contract.stringTags['event.environment'];
  if (environment === undefined) {
    return [
      "the SDK's renderer crash event no longer carries an `event.environment` tag with a literal value. restoreOwnRendererProcessTag only restores events tagged 'native', so it could no longer tell a native crash from any other event.",
    ];
  }

  const stamped = contract.stampFor(String(derivation.derive('renderer')), classifyForSdk, OWN_WINDOW_CONTENTS);
  const event = asErrorEvent({
    level: 'fatal',
    platform: 'native',
    tags: { 'event.environment': environment, [contract.tagKey]: stamped, 'exit.reason': 'crashed' },
    contexts: { electron: { [`${prefixOutcome.value}${derivation.annotationKey}`]: 'renderer' } },
  });

  restoreOwnRendererProcessTag(event);
  const tagAfter = event.tags?.[contract.tagKey];
  if (tagAfter !== 'renderer') {
    return [
      `an own-window renderer crash built from the SDK's own keys is tagged ${JSON.stringify(tagAfter)} after restoreOwnRendererProcessTag, not 'renderer'. It reads tags['event.environment'] === 'native', tags['event.process'] === 'unknown' and contexts.electron['${OUR_CRASHPAD_PREFIX}process_type'], and one of those no longer matches what the SDK writes (the SDK wrote tags[${JSON.stringify(contract.tagKey)}] = ${JSON.stringify(stamped)}, tags['event.environment'] = ${JSON.stringify(environment)}, contexts.electron[${JSON.stringify(`${prefixOutcome.value}${derivation.annotationKey}`)}] = 'renderer'). Own window crashes would stay tagged ${JSON.stringify(stamped)}.`,
    ];
  }
  return [];
}

// ---------------------------------------------------------------------------
// Real source.
// ---------------------------------------------------------------------------

describe('the sentry-minidump integration files this pin reads', () => {
  it('include the one node resolves for @sentry/electron/main under the require condition', () => {
    expect(
      path.resolve(packageRoot, mainExports.require.default),
      "@sentry/electron's exports['./main'].require no longer points at the file node resolves; the CJS pin below would read a different file than the bundle's",
    ).toBe(path.resolve(resolvedMainEntry));
  });

  it.each(INSTALLED_TWINS)('exist: $label', ({ file }) => {
    expect(fs.existsSync(file), `${file} is missing; @sentry/electron moved its sentry-minidump integration`).toBe(true);
  });
});

describe.each(INSTALLED_TWINS)('the installed @sentry/electron sentry-minidump integration, $label', ({ file }) => {
  const sourceText = fs.readFileSync(file, 'utf-8');

  it("stamps a renderer crash's event.process tag from getRendererName(contents), which is how a Browser pane page is told apart", () => {
    expect(checkProcessTag(sourceText)).toEqual([]);
  });

  it("re-keys the dump's Crashpad annotations with the prefix native-crash-event.ts scrubs by, inside contexts.electron", () => {
    expect(checkCrashpadPrefix(sourceText)).toEqual([]);
  });

  it('builds the renderer crash event with exactly the contexts.electron keys the scrub accounts for', () => {
    expect(checkRendererCrashElectronContext(sourceText)).toEqual([]);
  });

  it("leaves only the exit details after our Browser pane scrub, for an event built from the SDK's own keys", () => {
    expect(checkScrubEndToEnd(sourceText)).toEqual([]);
  });

  it("falls back to 'unknown' for a renderer getRendererName leaves unnamed, the tag restoreOwnRendererProcessTag puts right", () => {
    expect(checkOwnWindowFallback(sourceText)).toEqual([]);
  });

  it("derives the crashed process's type from the dump's process_type annotation, which restoreOwnRendererProcessTag reads back", () => {
    expect(checkProcessTypeDerivation(sourceText)).toEqual([]);
  });

  it("tags an own window renderer crash 'renderer' after our restore, for an event built from the SDK's own keys", () => {
    expect(checkRestoreEndToEnd(sourceText)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Negative controls. A faithful stand-in for the integration passes every check, and one
// deliberate break at a time makes the matching check go red. Without these, a check whose
// extractor quietly matched too much would pass against any SDK.
// ---------------------------------------------------------------------------

interface FakeSdkVariant {
  tagKey: string;
  tagValue: string;
  rendererNameExpression: string;
  annotationPrefix: string;
  mergeAnnotations: boolean;
  crashedUrlKey: string;
  /** How `minidumpProcess` is derived from the dump, in terms of the `minidumpResult` the loader hands over. */
  processTypeExpression: string;
  /** The expression the `event.environment` tag on the renderer crash event is set from. */
  environmentTagExpression: string;
}

const FAITHFUL_SDK: FakeSdkVariant = {
  tagKey: 'event.process',
  tagValue: 'crashedProcess',
  rendererNameExpression:
    "(minidumpProcess === 'renderer' && getRendererName ? getRendererName(contents) : minidumpProcess) || 'unknown'",
  annotationPrefix: 'crashpad.',
  mergeAnnotations: true,
  crashedUrlKey: 'crashed_url',
  processTypeExpression: "minidumpResult.crashpadAnnotations?.process_type?.replace('-process', '')",
  environmentTagExpression: "'native'",
};

/** The shape of the real integration's two relevant functions, with one knob per way it could drift. */
function fakeSdkSource(overrides: Partial<FakeSdkVariant> = {}): string {
  const variant = { ...FAITHFUL_SDK, ...overrides };
  return [
    'async function sendNativeCrashes(client, getEvent) {',
    '  await minidumpLoader(false, async (minidumpResult, attachment) => {',
    `    const minidumpProcess = ${variant.processTypeExpression};`,
    '    const event = await getEvent(minidumpProcess);',
    '    if (minidumpResult.crashpadAnnotations) {',
    `      const prependedAnnotations = Object.entries(minidumpResult.crashpadAnnotations).reduce((acc, [key, val]) => ((acc[\`${variant.annotationPrefix}\${key}\`] = val), acc), {});`,
    '      event.contexts = {',
    '        ...event.contexts,',
    '        electron: {',
    '          ...event.contexts?.electron,',
    variant.mergeAnnotations ? '          ...prependedAnnotations,' : '',
    '        },',
    '      };',
    '    }',
    '  });',
    '}',
    'async function sendRendererCrash(client, options, contents, details) {',
    '  const { getRendererName } = options;',
    '  await sendNativeCrashes(client, (minidumpProcess) => {',
    `    const crashedProcess = ${variant.rendererNameExpression};`,
    '    return {',
    `      contexts: { electron: { ${variant.crashedUrlKey}: getRendererProperties(contents.id)?.url || 'unknown', details } },`,
    "      level: 'fatal',",
    `      tags: { 'event.environment': ${variant.environmentTagExpression}, '${variant.tagKey}': ${variant.tagValue}, 'exit.reason': details.reason },`,
    '    };',
    '  });',
    '}',
  ].join('\n');
}

describe('the contract checks can fail', () => {
  it('pass for a faithful stand-in, so the extractors read the real shape', () => {
    const source = fakeSdkSource();
    expect(checkProcessTag(source)).toEqual([]);
    expect(checkCrashpadPrefix(source)).toEqual([]);
    expect(checkRendererCrashElectronContext(source)).toEqual([]);
    expect(checkScrubEndToEnd(source)).toEqual([]);
    expect(checkOwnWindowFallback(source)).toEqual([]);
    expect(checkProcessTypeDerivation(source)).toEqual([]);
    expect(checkRestoreEndToEnd(source)).toEqual([]);
  });

  it('flag an SDK that stamps event.process from something other than getRendererName', () => {
    const source = fakeSdkSource({ tagValue: 'minidumpProcess' });
    expect(checkProcessTag(source).join('\n')).toMatch(/no longer stamps event\.process from getRendererName/);
    expect(checkScrubEndToEnd(source).join('\n')).toMatch(/no longer stamps event\.process from getRendererName/);
  });

  it('flag an SDK whose expression never calls getRendererName', () => {
    const source = fakeSdkSource({ rendererNameExpression: "minidumpProcess || 'unknown'" });
    expect(checkProcessTag(source).join('\n')).toMatch(/no longer stamps event\.process from getRendererName/);
  });

  it('flag an SDK that moves the process tag to another key', () => {
    const source = fakeSdkSource({ tagKey: 'process' });
    expect(checkProcessTag(source).join('\n')).toMatch(/isBrowserGuestCrashEvent reads tags\['event\.process'\]/);
    expect(checkScrubEndToEnd(source).join('\n')).toMatch(/not recognised as a Browser pane page crash/);
  });

  it('flag an SDK that changes the Crashpad annotation prefix', () => {
    const source = fakeSdkSource({ annotationPrefix: 'annotation.' });
    expect(checkCrashpadPrefix(source).join('\n')).toMatch(/prefixes Crashpad annotations with "annotation\."/);
    // The scrub deletes by OUR prefix, so the SDK's differently-prefixed annotations survive it.
    expect(checkScrubEndToEnd(source).join('\n')).toMatch(/still holds \[[^\]]*annotation\.ptype[^\]]*\]/);
  });

  it('flag an SDK that stops merging annotations into contexts.electron', () => {
    const source = fakeSdkSource({ mergeAnnotations: false });
    expect(checkCrashpadPrefix(source).join('\n')).toMatch(/no longer merges the re-keyed Crashpad annotations/);
  });

  it('flag an SDK that renames the crashed page URL key', () => {
    const source = fakeSdkSource({ crashedUrlKey: 'crashedUrl' });
    expect(checkRendererCrashElectronContext(source).join('\n')).toMatch(/instead of \[crashed_url, details\]/);
    expect(checkScrubEndToEnd(source).join('\n')).toMatch(/still holds \[crashedUrl, details\]/);
  });

  it("flag an SDK that falls back to 'renderer' for an unnamed renderer, which leaves the restore nothing to fix", () => {
    const source = fakeSdkSource({
      rendererNameExpression:
        "(minidumpProcess === 'renderer' && getRendererName ? getRendererName(contents) : minidumpProcess) || 'renderer'",
    });
    expect(checkOwnWindowFallback(source).join('\n')).toMatch(/is now a no-op and can be removed/);
    // Only this pin cares what an own window falls back to. An own window stamped 'renderer' needs no
    // restoring, so the end-to-end check is satisfied and so is the Browser pane check.
    expect(checkProcessTag(source)).toEqual([]);
    expect(checkRestoreEndToEnd(source)).toEqual([]);
  });

  it('flag an SDK that falls back to some other name for an unnamed renderer', () => {
    const source = fakeSdkSource({
      rendererNameExpression:
        "(minidumpProcess === 'renderer' && getRendererName ? getRendererName(contents) : minidumpProcess) || 'window'",
    });
    expect(checkOwnWindowFallback(source).join('\n')).toMatch(/now stamps "window" for a renderer that getRendererName leaves unnamed/);
    expect(checkRestoreEndToEnd(source).join('\n')).toMatch(/is tagged "window" after restoreOwnRendererProcessTag/);
  });

  it("flag an SDK that no longer derives its process type from a Crashpad annotation", () => {
    const source = fakeSdkSource({ processTypeExpression: "'renderer'" });
    expect(checkProcessTypeDerivation(source).join('\n')).toMatch(/no longer derives the crashed process's type/);
    expect(checkRestoreEndToEnd(source).join('\n')).toMatch(/no longer derives the crashed process's type/);
  });

  it('flag an SDK that stops stripping -process from the annotation value', () => {
    const source = fakeSdkSource({ processTypeExpression: 'minidumpResult.crashpadAnnotations?.process_type' });
    expect(checkProcessTypeDerivation(source).join('\n')).toMatch(/instead of stripping the suffix to 'gpu'/);
    // A renderer's annotation carries no suffix, so only the mirrored strip is stale, not the restore.
    expect(checkRestoreEndToEnd(source)).toEqual([]);
  });

  it("flag an SDK that derives something other than 'renderer' for a renderer dump", () => {
    const source = fakeSdkSource({
      processTypeExpression: "minidumpResult.crashpadAnnotations?.process_type?.replace('renderer', 'window')",
    });
    expect(checkProcessTypeDerivation(source).join('\n')).toMatch(/derives "window" from a renderer dump's "process_type" annotation instead of 'renderer'/);
    expect(checkRestoreEndToEnd(source).join('\n')).toMatch(/after restoreOwnRendererProcessTag/);
  });

  it('flag an SDK that reads the process type from a differently named annotation', () => {
    const source = fakeSdkSource({
      processTypeExpression: "minidumpResult.crashpadAnnotations?.ptype?.replace('-process', '')",
    });
    // The SDK's own derivation is still sound, so this is the restore's literal going stale.
    expect(checkProcessTypeDerivation(source)).toEqual([]);
    const problems = checkRestoreEndToEnd(source).join('\n');
    expect(problems).toMatch(/is tagged "unknown" after restoreOwnRendererProcessTag/);
    expect(problems).toMatch(/contexts\.electron\["crashpad\.ptype"\]/);
  });

  it('flag an SDK that stops copying annotations under the prefix the restore reads', () => {
    const source = fakeSdkSource({ annotationPrefix: 'annotation.' });
    expect(checkRestoreEndToEnd(source).join('\n')).toMatch(/is tagged "unknown" after restoreOwnRendererProcessTag/);
  });

  it("flag an SDK that changes the value of the environment tag the restore gates on", () => {
    const source = fakeSdkSource({ environmentTagExpression: "'electron-native'" });
    expect(checkRestoreEndToEnd(source).join('\n')).toMatch(/is tagged "unknown" after restoreOwnRendererProcessTag/);
  });

  it('flag an SDK that stops giving the environment tag a literal value', () => {
    const source = fakeSdkSource({ environmentTagExpression: 'details.environment' });
    expect(checkRestoreEndToEnd(source).join('\n')).toMatch(/no longer carries an `event\.environment` tag with a literal value/);
  });
});
