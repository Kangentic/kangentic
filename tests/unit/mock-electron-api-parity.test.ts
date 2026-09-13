/**
 * Self-maintaining guard that `tests/ui/mock-electron-api.js` implements every
 * member the `ElectronAPI` interface in `src/shared/types.ts` declares.
 *
 * The UI tier has always tolerated a gap here: a spec that never reaches a
 * missing method never notices it. The web build of the renderer (`demo/`)
 * cannot: it runs the REAL renderer against this mock as its only bridge, so a
 * method the interface declares and the mock lacks is invisible at build time
 * (the mock is untyped browser JS) and becomes `TypeError: ... is not a
 * function` on whichever click first reaches it. This test turns that into a
 * CI failure that names every missing member at once.
 *
 * Two halves:
 *
 * 1. The interface is read with the TypeScript compiler API. A single-file
 *    parse is enough: the interface's namespaces are inline type literals and
 *    the file's only imports are `import type`, so no Program or checker is
 *    needed. Every property whose type is a type literal is a namespace
 *    (recursively, so `backlog.asana` counts); a property typed as a function,
 *    or a method signature, is a required method; anything else (`platform:
 *    string`, `popOut.descriptor`, `analytics.errorReportingEnabled`) is a
 *    required data property. Optional members (`dev?`, present only under
 *    `__KANGENTIC_DEV__`) are skipped at any depth. A property typed by a bare
 *    type reference or an intersection is refused outright rather than
 *    classified as data, because that is exactly where a namespace's methods
 *    could hide from this scan (a future `git: GitBridge` refactor): the parse
 *    fails loudly and says how to extend it.
 *
 * 2. The mock is EVALUATED, not text-scanned (unlike
 *    `mock-agent-list-parity.test.ts`, whose target is one fixture array).
 *    It is a classic-script IIFE that assigns `window.electronAPI` and reads
 *    `window.__mock*` overrides at load, so it runs inside a `node:vm` context
 *    with a minimal `window`. The context needs only what the mock touches at
 *    load or could plausibly touch on a future load path: `window` (also as
 *    `window.window`), `document` (undefined, so `typeof document` checks hold),
 *    `crypto` (Node's webcrypto, for `randomUUID`), the timers, and `console`.
 *    ECMAScript intrinsics (`Object`, `Promise`, `Date`, `Math`, `JSON`,
 *    `Array`) are deliberately NOT injected from the host realm: a fresh vm
 *    context already owns its own, which is how a browser runs this file, and
 *    shadowing them with host-realm copies would only invite cross-realm
 *    surprises.
 *
 * Extra members on the mock (test hooks, superseded methods) are allowed; the
 * check is one-directional. A vacuity guard pins the parse to a plausible size
 * (dozens of namespaces, hundreds of methods) so a refactor that breaks the
 * scan fails instead of passing on an empty list.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import * as ts from 'typescript';

const TYPES_PATH = path.resolve(__dirname, '../../src/shared/types.ts');
const MOCK_ELECTRON_API_PATH = path.resolve(__dirname, '../ui/mock-electron-api.js');

/** Floors for the vacuity guard. The interface had 39 namespaces (38 top-level
 *  plus the nested `backlog.asana`) and 276 methods when this was written; a
 *  parse that finds far fewer has broken. */
const MINIMUM_NAMESPACE_COUNT = 30;
const MINIMUM_METHOD_COUNT = 200;

interface DeclaredBridge {
  /** Required namespaces, dotted when nested (`backlog.asana`). */
  namespaces: string[];
  /** Required callable members, `namespace.method` (nested namespaces dotted). */
  methods: string[];
  /** Required non-callable members (`platform`, `popOut.descriptor`, ...). */
  dataProperties: string[];
  /** Optional members skipped at any depth (`dev` today). */
  skippedOptional: string[];
}

function findElectronApiInterface(sourceFile: ts.SourceFile): ts.InterfaceDeclaration {
  for (const statement of sourceFile.statements) {
    if (ts.isInterfaceDeclaration(statement) && statement.name.text === 'ElectronAPI') {
      return statement;
    }
  }
  throw new Error(
    'mock-electron-api-parity: no top-level `interface ElectronAPI` in src/shared/types.ts. '
    + 'If it moved or was renamed, update findElectronApiInterface() in '
    + 'tests/unit/mock-electron-api-parity.test.ts.',
  );
}

function memberNameOf(member: ts.TypeElement, ownerPath: string): string {
  const nameNode = member.name;
  if (nameNode !== undefined && (ts.isIdentifier(nameNode) || ts.isStringLiteral(nameNode))) {
    return nameNode.text;
  }
  throw new Error(
    `mock-electron-api-parity: unnamed or computed member (${ts.SyntaxKind[member.kind]}) under `
    + `ElectronAPI${ownerPath === '' ? '' : '.' + ownerPath}. Extend memberNameOf() in `
    + 'tests/unit/mock-electron-api-parity.test.ts if this shape is intended.',
  );
}

function unwrapParenthesized(typeNode: ts.TypeNode): ts.TypeNode {
  let current = typeNode;
  while (ts.isParenthesizedTypeNode(current)) {
    current = current.type;
  }
  return current;
}

/**
 * A type node that could carry members this scan cannot see. A bare reference
 * (`GitBridge`), an intersection (`A & B`) or a `typeof x` query would have to
 * be resolved through the type checker to enumerate; refusing them keeps the
 * scan honest instead of silently demoting a namespace to a data property.
 */
function couldHideMembers(typeNode: ts.TypeNode): boolean {
  return ts.isTypeReferenceNode(typeNode)
    || ts.isIntersectionTypeNode(typeNode)
    || ts.isTypeQueryNode(typeNode);
}

function collectMembers(
  members: ts.NodeArray<ts.TypeElement>,
  ownerPath: string,
  into: DeclaredBridge,
): void {
  for (const member of members) {
    const name = memberNameOf(member, ownerPath);
    const memberPath = ownerPath === '' ? name : `${ownerPath}.${name}`;

    if (member.questionToken !== undefined) {
      into.skippedOptional.push(memberPath);
      continue;
    }
    if (ts.isMethodSignature(member)) {
      into.methods.push(memberPath);
      continue;
    }
    if (!ts.isPropertySignature(member)) {
      throw new Error(
        `mock-electron-api-parity: unsupported member kind ${ts.SyntaxKind[member.kind]} at `
        + `ElectronAPI.${memberPath}. Extend collectMembers() in `
        + 'tests/unit/mock-electron-api-parity.test.ts.',
      );
    }
    if (member.type === undefined) {
      throw new Error(
        `mock-electron-api-parity: ElectronAPI.${memberPath} has no type annotation; `
        + 'the scan cannot classify it.',
      );
    }
    const typeNode = unwrapParenthesized(member.type);
    if (ts.isFunctionTypeNode(typeNode)) {
      into.methods.push(memberPath);
      continue;
    }
    if (ts.isTypeLiteralNode(typeNode)) {
      into.namespaces.push(memberPath);
      collectMembers(typeNode.members, memberPath, into);
      continue;
    }
    if (couldHideMembers(typeNode)) {
      throw new Error(
        `mock-electron-api-parity: ElectronAPI.${memberPath} is typed by a `
        + `${ts.SyntaxKind[typeNode.kind]}, which this scan cannot see into. If it is a `
        + 'namespace, inline its members as a type literal (the convention every other '
        + 'namespace follows) or teach collectMembers() in '
        + 'tests/unit/mock-electron-api-parity.test.ts to resolve it through the type checker. '
        + 'If it is plain data, widen it to a union (`X | null`) or make it optional.',
      );
    }
    into.dataProperties.push(memberPath);
  }
}

function readDeclaredBridge(): DeclaredBridge {
  const source = fs.readFileSync(TYPES_PATH, 'utf-8');
  const sourceFile = ts.createSourceFile(
    TYPES_PATH,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TS,
  );
  const declared: DeclaredBridge = {
    namespaces: [],
    methods: [],
    dataProperties: [],
    skippedOptional: [],
  };
  collectMembers(findElectronApiInterface(sourceFile).members, '', declared);
  return declared;
}

type MockObject = Record<string, unknown>;

function isMockObject(value: unknown): value is MockObject {
  return typeof value === 'object' && value !== null;
}

/**
 * Run the mock the way a page would: as a script with a `window` global. The
 * `window.window` alias exists because the mock is loaded via addInitScript,
 * where `window` is also the global; nothing in the file needs it today, but a
 * self-reference is the cheapest way to keep that true for a future guard.
 */
function loadMockElectronApi(): MockObject {
  const source = fs.readFileSync(MOCK_ELECTRON_API_PATH, 'utf-8');
  const windowObject: MockObject = {};
  windowObject.window = windowObject;
  const sandbox: MockObject = {
    window: windowObject,
    document: undefined,
    crypto: webcrypto,
    setTimeout,
    clearTimeout,
    console,
  };
  vm.runInNewContext(source, sandbox, { filename: MOCK_ELECTRON_API_PATH, timeout: 5000 });
  const electronApi = windowObject.electronAPI;
  if (!isMockObject(electronApi)) {
    throw new Error(
      'mock-electron-api-parity: evaluating tests/ui/mock-electron-api.js did not assign an '
      + 'object to window.electronAPI. Either the mock no longer attaches itself to `window`, '
      + 'or it now needs a global the vm sandbox in loadMockElectronApi() does not provide.',
    );
  }
  return electronApi;
}

interface ResolvedMember {
  owner: MockObject | null;
  key: string;
}

/** Walk a dotted path on the mock, returning the owning object of its last segment. */
function resolveOnMock(root: MockObject, memberPath: string): ResolvedMember {
  const segments = memberPath.split('.');
  const key = segments[segments.length - 1];
  let owner: MockObject | null = root;
  for (const segment of segments.slice(0, -1)) {
    const next: unknown = owner[segment];
    if (!isMockObject(next)) {
      owner = null;
      break;
    }
    owner = next;
  }
  return { owner, key };
}

describe('mock-electron-api implements the whole ElectronAPI interface', () => {
  it('every namespace, method and data property the interface declares exists on the mock', () => {
    const declared = readDeclaredBridge();
    const electronApi = loadMockElectronApi();
    const missing: string[] = [];

    for (const namespacePath of declared.namespaces) {
      const { owner, key } = resolveOnMock(electronApi, namespacePath);
      if (owner === null || !isMockObject(owner[key])) {
        missing.push(`${namespacePath} (namespace)`);
      }
    }
    for (const methodPath of declared.methods) {
      const { owner, key } = resolveOnMock(electronApi, methodPath);
      if (owner === null || typeof owner[key] !== 'function') {
        missing.push(`${methodPath} (method)`);
      }
    }
    for (const propertyPath of declared.dataProperties) {
      const { owner, key } = resolveOnMock(electronApi, propertyPath);
      if (owner === null || !(key in owner)) {
        missing.push(`${propertyPath} (data property)`);
      }
    }

    expect(
      missing,
      `The ElectronAPI interface (src/shared/types.ts) declares ${missing.length} member(s) that `
      + 'tests/ui/mock-electron-api.js does not implement:\n  '
      + missing.join('\n  ')
      + '\nThe web build (demo/) runs the real renderer against this mock, so each of these is '
      + 'a runtime TypeError there. Add each one to the mock (a function for a method, a '
      + 'value for a data property) so the mock stays a complete mirror of the bridge.',
    ).toEqual([]);
  });

  it('platform is a string on the mock', () => {
    // `platform` is the one top-level non-namespace member. The mock exposes it
    // as a getter (so `window.__mockPlatform` can override it per spec), and a
    // getter that returned undefined would pass a bare presence check.
    const electronApi = loadMockElectronApi();
    expect(typeof electronApi.platform).toBe('string');
  });

  it('sanity: the interface parse found a plausible bridge', () => {
    // Guards the AST walk against silent drift: if the interface is reshaped so
    // that collectMembers() finds nothing (or almost nothing), the parity
    // assertion above would pass vacuously no matter how far the mock drifted.
    const declared = readDeclaredBridge();
    expect(declared.namespaces.length).toBeGreaterThan(MINIMUM_NAMESPACE_COUNT);
    expect(declared.methods.length).toBeGreaterThan(MINIMUM_METHOD_COUNT);
    expect(new Set(declared.methods).size).toBe(declared.methods.length);
    // The one documented optional namespace. Its absence from the required set
    // must come from the optional filter, not from a parser gap; if `dev` is
    // ever removed from the interface, drop this line with it.
    expect(declared.skippedOptional).toContain('dev');
  });
});
