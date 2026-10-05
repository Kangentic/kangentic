/**
 * Static-scan regression guard for the dev-quick-pair backdoor
 * (src/main/mobile-bridge/dev-quick-pair.ts).
 *
 * dev-quick-pair.ts adopts the mobile dev rig's phone key straight into the
 * signed roster with every capability granted, no SAS ceremony - a
 * deliberate dev-only backdoor that "must never exist in production" (its
 * own header). TWO sites must stay gated, not just one:
 *
 * 1. The CONSTRUCTION site (`new DevQuickPair(...)` in the constructor).
 *    This is the one that actually matters for esbuild's dead-code
 *    elimination: an unconditional `new DevQuickPair(...)` field initializer
 *    keeps the whole class (and its console.warn/log strings, roster-adopt
 *    logic, and file-watching mechanism) reachable in the production bundle
 *    even if every CALL to its methods is gated - the class merely never
 *    gets used, it does not get eliminated. This was a real, verified gap:
 *    the module shipped inert-but-present in a production build until the
 *    construction itself was moved behind `__KANGENTIC_DEV__ ? new
 *    DevQuickPair(...) : null` in the constructor.
 * 2. The `.reconcile()` CALL site, gated separately so a production build
 *    (where the field is always `null`) never invokes it.
 *
 * A THIRD, independent invariant guards the same dead-code-elimination goal
 * one level down, inside dev-quick-pair.ts itself: `devPairingDir()`'s
 * `.kangentic/mobile-dev-pairing` path is built INLINE inside the function
 * body, not as a top-level `const x = path.join(...)`. A top-level const
 * initialized by a function call is a call esbuild cannot prove
 * side-effect-free, so it survives tree-shaking (as a dangling string
 * literal) even once nothing else in the module is reachable. Re-hoisting it
 * back to module scope would silently reintroduce that leak, so it gets its
 * own scan below.
 *
 * This cannot be a behavioral test: __KANGENTIC_DEV__ is a compile-time
 * substitution, and vitest.config.ts pins it to `false`, so the gated branch
 * is simply dead code at test time - a runtime assertion could not observe
 * whether either gate is still there or was accidentally removed. A source
 * scan is the only way to pin this, mirroring esbuild-cjs-imports.test.ts's
 * approach for a similarly compile-time-only invariant.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import * as ts from 'typescript';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const SERVICE_PATH = path.join(REPO_ROOT, 'src/main/mobile-bridge/mobile-bridge-service.ts');
const DEV_QUICK_PAIR_PATH = path.join(REPO_ROOT, 'src/main/mobile-bridge/dev-quick-pair.ts');

describe('dev-quick-pair stays gated to dev builds', () => {
  it('DevQuickPair is constructed only inside a __KANGENTIC_DEV__ ternary, never unconditionally', () => {
    const source = fs.readFileSync(SERVICE_PATH, 'utf-8');
    // Exactly one, not merely at-least-one. The ternary regex below only
    // inspects its TRUE branch, so `__KANGENTIC_DEV__ ? new DevQuickPair(devArgs)
    // : new DevQuickPair(prodArgs)` would satisfy it while defeating the whole
    // invariant. Counting the construction sites is what rules that out.
    //
    // Counted over code with comments stripped: the JSDoc on the devQuickPair
    // field documents this very invariant and says `new DevQuickPair(...)` in
    // prose, so a raw scan of the file finds two and fails on the comment.
    const codeOnly = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    const constructionSiteCount = (codeOnly.match(/new DevQuickPair\(/g) ?? []).length;
    expect(
      constructionSiteCount,
      'expected exactly one `new DevQuickPair(...)` construction site in mobile-bridge-service.ts - zero means it moved ' +
        '(this test is now vacuous), more than one means a second, possibly ungated construction was added.',
    ).toBe(1);

    // Directly matches `__KANGENTIC_DEV__ ? new DevQuickPair(` as one
    // ternary (whitespace/newlines between the '?' and the construction
    // tolerated). A plain lastIndexOf scan back from the construction site
    // is unreliable here: a nearby JSDoc comment mentioning
    // `__KANGENTIC_DEV__` in prose (documenting exactly this invariant)
    // sits textually closer than the real ternary condition.
    expect(
      /__KANGENTIC_DEV__\s*\?\s*\n?\s*new DevQuickPair\(/.test(source),
      '`new DevQuickPair(...)` must be constructed only behind a `__KANGENTIC_DEV__ ? new DevQuickPair(...) : null` ' +
        'ternary, not as an unconditional field initializer - an unconditional construction keeps the whole class ' +
        'reachable in a production bundle even if its methods are never called (verified empirically: the module ' +
        'shipped inert-but-present until this was fixed).',
    ).toBe(true);
  });

  // The quick pair is reconciled through one helper, reconcileDevQuickPair(), because enabling it
  // now waits for the async secure-storage warm-up and the identity first. So the invariant has
  // two halves: every `.reconcile(` on the quick pair lives inside that helper, and the helper is
  // called only from inside an `if (__KANGENTIC_DEV__)` block.
  it('the dev quick pair is reconciled only through a helper called inside an if (__KANGENTIC_DEV__) block', () => {
    const source = fs.readFileSync(SERVICE_PATH, 'utf-8');

    const definitionIndex = source.indexOf('private reconcileDevQuickPair(');
    expect(definitionIndex, 'could not find reconcileDevQuickPair() in mobile-bridge-service.ts - has it moved?').toBeGreaterThan(-1);
    const bodyStart = source.indexOf('{', definitionIndex);
    let depth = 0;
    let bodyEnd = -1;
    for (let index = bodyStart; index < source.length; index += 1) {
      if (source[index] === '{') depth += 1;
      if (source[index] === '}') depth -= 1;
      if (depth === 0) {
        bodyEnd = index;
        break;
      }
    }
    expect(bodyEnd, 'could not find the end of reconcileDevQuickPair()').toBeGreaterThan(bodyStart);

    const reconcileCalls = [...source.matchAll(/devQuickPair\??\.reconcile\(/g)].map((match) => match.index ?? -1);
    expect(reconcileCalls.length, 'no dev quick pair reconcile() call found - this test would be vacuous').toBeGreaterThan(0);
    for (const callIndex of reconcileCalls) {
      expect(
        callIndex > bodyStart && callIndex < bodyEnd,
        'every dev quick pair reconcile() call must stay inside reconcileDevQuickPair(), the one helper the ' +
          '`if (__KANGENTIC_DEV__)` gate below covers',
      ).toBe(true);
    }

    const helperCalls = [...source.matchAll(/this\.reconcileDevQuickPair\(/g)].map((match) => match.index ?? -1);
    expect(helperCalls, 'expected exactly one call to reconcileDevQuickPair()').toHaveLength(1);
    const callIndex = helperCalls[0];

    const guardIndex = source.lastIndexOf('if (__KANGENTIC_DEV__)', callIndex);
    expect(
      guardIndex,
      'reconcileDevQuickPair() must be called only inside an `if (__KANGENTIC_DEV__)` block - this is a ' +
        'deliberate dev-only backdoor (see dev-quick-pair.ts header) that must be dead-code-eliminated ' +
        'from production builds.',
    ).toBeGreaterThan(-1);

    // The guard must actually still be open at the call site: no closing
    // brace for the if-block between the guard and the call.
    const between = source.slice(guardIndex, callIndex);
    const openBraces = (between.match(/\{/g) ?? []).length;
    const closeBraces = (between.match(/\}/g) ?? []).length;
    expect(
      openBraces,
      'the nearest `if (__KANGENTIC_DEV__)` above the call site does not actually enclose it (brace mismatch)',
    ).toBeGreaterThan(closeBraces);
  });

  // reconcileDevQuickPair() awaits the secure-storage warm-up and then the identity before it
  // enables the quick pair, and dispose() can run during either one. dispose() stops the quick
  // pair, so a continuation that carried on after it would restart the very thing dispose() just
  // stopped. The body is dead code under vitest (`__KANGENTIC_DEV__` is pinned false), so no test
  // can run it and the guard has to be pinned on the source. Parsed with the TypeScript compiler
  // API, as guarded-sync-writes.test.ts does, so the shape of the check (a multi-line `if`, a
  // braced `return`) cannot hide a deleted guard or fake one.
  //
  // Scoped to the NEXT reconcile() after each await, not to "some guard exists after it": deleting
  // the first guard would otherwise stay green, because the second one still sits after the first
  // await. The first await's next quick pair call is reconcile(false), which is exactly the call
  // that guard protects.
  it('reconcileDevQuickPair() re-checks this.disposed after every await, before the next quick pair reconcile()', () => {
    const source = fs.readFileSync(SERVICE_PATH, 'utf-8');
    const sourceFile = ts.createSourceFile('mobile-bridge-service.ts', source, ts.ScriptTarget.Latest, true);

    const helperDeclarations: ts.MethodDeclaration[] = [];
    function findHelper(node: ts.Node): void {
      if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'reconcileDevQuickPair') {
        helperDeclarations.push(node);
      }
      ts.forEachChild(node, findHelper);
    }
    findHelper(sourceFile);
    expect(helperDeclarations, 'expected exactly one reconcileDevQuickPair() method in mobile-bridge-service.ts - has it moved or been renamed?').toHaveLength(1);
    const helperBody = helperDeclarations[0].body;
    expect(helperBody, 'reconcileDevQuickPair() has no body to scan').toBeDefined();

    function mentionsThisDisposed(node: ts.Node): boolean {
      if (
        ts.isPropertyAccessExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ThisKeyword &&
        node.name.text === 'disposed'
      ) {
        return true;
      }
      return ts.forEachChild(node, mentionsThisDisposed) ?? false;
    }
    function leavesTheMethod(statement: ts.Statement): boolean {
      return ts.isReturnStatement(statement)
        || (ts.isBlock(statement) && statement.statements.some((inner) => ts.isReturnStatement(inner)));
    }

    const awaitEndPositions: number[] = [];
    const quickPairReconcileStartPositions: number[] = [];
    const disposedGuardStartPositions: number[] = [];
    function scanHelperBody(node: ts.Node): void {
      if (ts.isAwaitExpression(node)) {
        awaitEndPositions.push(node.getEnd());
      }
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'reconcile' &&
        /^(this\.)?devQuickPair$/.test(node.expression.expression.getText(sourceFile))
      ) {
        quickPairReconcileStartPositions.push(node.getStart(sourceFile));
      }
      if (ts.isIfStatement(node) && mentionsThisDisposed(node.expression) && leavesTheMethod(node.thenStatement)) {
        disposedGuardStartPositions.push(node.getStart(sourceFile));
      }
      ts.forEachChild(node, scanHelperBody);
    }
    scanHelperBody(helperBody!);

    expect(awaitEndPositions.length, 'no await found in reconcileDevQuickPair() - this test would be vacuous, move the pin with the awaits').toBeGreaterThan(0);
    expect(quickPairReconcileStartPositions.length, 'no devQuickPair.reconcile() call found in reconcileDevQuickPair() - this test would be vacuous').toBeGreaterThan(0);

    let awaitsFollowedByAReconcile = 0;
    for (const awaitEnd of awaitEndPositions) {
      const nextReconcileStart = quickPairReconcileStartPositions
        .filter((reconcileStart) => reconcileStart > awaitEnd)
        .sort((first, second) => first - second)[0];
      if (nextReconcileStart === undefined) continue;
      awaitsFollowedByAReconcile += 1;

      const awaitLine = sourceFile.getLineAndCharacterOfPosition(awaitEnd).line + 1;
      const hasGuardInBetween = disposedGuardStartPositions.some(
        (guardStart) => guardStart >= awaitEnd && guardStart < nextReconcileStart,
      );
      expect(
        hasGuardInBetween,
        `the await ending at mobile-bridge-service.ts:${awaitLine} in reconcileDevQuickPair() must be followed by an ` +
          '`if (this.disposed) return;` before the next devQuickPair.reconcile(...). dispose() stops the quick pair, so a ' +
          'service disposed while that await was pending would otherwise restart it: it watches the dev pairing directory ' +
          'and adopts a phone key into the signed roster with every capability granted.',
      ).toBe(true);
    }
    expect(awaitsFollowedByAReconcile, 'no await in reconcileDevQuickPair() is followed by a reconcile() call - this test would be vacuous').toBeGreaterThan(0);
  });

  it('the dev-pairing directory path is built inline, never as a top-level path.*() const', () => {
    const source = fs.readFileSync(DEV_QUICK_PAIR_PATH, 'utf-8');

    // devPairingDir() itself must still build the path inline (the function
    // this invariant is actually about) - guards against the whole helper
    // disappearing silently, which would make the negative assertion below
    // vacuously true.
    expect(
      source.includes("path.resolve(process.cwd(), path.join('.kangentic', 'mobile-dev-pairing'))"),
      'devPairingDir() should build the dev-pairing path inline inside the function body - has it moved or changed shape?',
    ).toBe(true);

    // No top-level (column-0) `const x = path.join(...)` / `path.resolve(...)`
    // anywhere in the file: such a const is a function call esbuild cannot
    // prove side-effect-free, so it survives tree-shaking as a dangling
    // string literal even after the rest of the module is unreachable dead
    // code - the exact leak this file's header documents as already fixed
    // once (DEV_PAIRING_DIRNAME, removed). Column-0 only, deliberately: a
    // const declared inside a function or class body (indented) is fine,
    // since it dies with its enclosing scope when nothing calls that scope.
    // `export const` and `let` reintroduce the identical leak, so the anchor
    // has to admit both rather than just a bare `const`.
    expect(
      /^(export\s+)?(const|let|var)\s+\w+\s*=\s*path\.(join|resolve)\(/m.test(source),
      'no top-level `const x = path.join(...)`/`path.resolve(...)` in dev-quick-pair.ts - that survives esbuild tree-shaking ' +
        'as a dangling string literal even once the module is otherwise unreachable dead code. Build the path inline inside ' +
        'the function that needs it instead (see devPairingDir()).',
    ).toBe(false);
  });
});
