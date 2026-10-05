/**
 * Pins the parts of the installed `@sentry/electron` that the Browser pane crash scrub
 * (src/main/analytics/native-crash-event.ts) silently depends on.
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

    return {
      tagKey,
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
}

const FAITHFUL_SDK: FakeSdkVariant = {
  tagKey: 'event.process',
  tagValue: 'crashedProcess',
  rendererNameExpression:
    "(minidumpProcess === 'renderer' && getRendererName ? getRendererName(contents) : minidumpProcess) || 'unknown'",
  annotationPrefix: 'crashpad.',
  mergeAnnotations: true,
  crashedUrlKey: 'crashed_url',
};

/** The shape of the real integration's two relevant functions, with one knob per way it could drift. */
function fakeSdkSource(overrides: Partial<FakeSdkVariant> = {}): string {
  const variant = { ...FAITHFUL_SDK, ...overrides };
  return [
    'async function sendNativeCrashes(client, getEvent) {',
    '  await minidumpLoader(false, async (minidumpResult, attachment) => {',
    "    const minidumpProcess = minidumpResult.crashpadAnnotations?.process_type?.replace('-process', '');",
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
    `      tags: { 'event.environment': 'native', '${variant.tagKey}': ${variant.tagValue}, 'exit.reason': details.reason },`,
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
});
