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

const REPO_ROOT = path.resolve(__dirname, '../../..');
const SERVICE_PATH = path.join(REPO_ROOT, 'src/main/mobile-bridge/mobile-bridge-service.ts');
const DEV_QUICK_PAIR_PATH = path.join(REPO_ROOT, 'src/main/mobile-bridge/dev-quick-pair.ts');

describe('dev-quick-pair stays gated to dev builds', () => {
  it('DevQuickPair is constructed only inside a __KANGENTIC_DEV__ ternary, never unconditionally', () => {
    const source = fs.readFileSync(SERVICE_PATH, 'utf-8');
    expect(source.indexOf('new DevQuickPair('), 'could not find the `new DevQuickPair(...)` construction site - has it moved?').toBeGreaterThan(-1);

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

  it('devQuickPair?.reconcile() is called only inside an if (__KANGENTIC_DEV__) block', () => {
    const source = fs.readFileSync(SERVICE_PATH, 'utf-8');
    const callIndex = source.indexOf('this.devQuickPair?.reconcile(');
    expect(callIndex, 'could not find the devQuickPair?.reconcile() call site in mobile-bridge-service.ts - has it moved?').toBeGreaterThan(-1);

    const guardIndex = source.lastIndexOf('if (__KANGENTIC_DEV__)', callIndex);
    expect(
      guardIndex,
      'devQuickPair?.reconcile() must stay inside an `if (__KANGENTIC_DEV__)` block - this is a ' +
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
    expect(
      /^const\s+\w+\s*=\s*path\.(join|resolve)\(/m.test(source),
      'no top-level `const x = path.join(...)`/`path.resolve(...)` in dev-quick-pair.ts - that survives esbuild tree-shaking ' +
        'as a dangling string literal even once the module is otherwise unreachable dead code. Build the path inline inside ' +
        'the function that needs it instead (see devPairingDir()).',
    ).toBe(false);
  });
});
