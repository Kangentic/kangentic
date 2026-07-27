/**
 * The onboarding walkthrough is the one feature that reaches ACROSS subsystems by CSS
 * selector: it rings controls that live in the settings tabs, the board manager dialog,
 * and the board itself. Nothing in those files knows the walkthrough points at them, so a
 * routine rename ("project-default-agent" -> "agent-default"), a setting moved to another
 * tab, or a restructured dialog silently breaks it.
 *
 * Silently is the operative word. WalkthroughLayer renders NOTHING when its target does
 * not resolve, so a broken step looks like a step that simply chose not to highlight
 * anything. There is no console error and no crash to notice.
 *
 * This is the cheap half of the guard: every test id the steps name must still exist in
 * the renderer, and every step must be exercised by the UI spec. The expensive half - that
 * the element is actually RENDERED and visible once the step opens its surface, which is
 * what catches a setting moving to a different tab - lives in
 * tests/ui/onboarding-walkthrough.spec.ts, and the coverage check below is what forces a
 * newly added step to get one.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const STEPS_FILE = path.join(REPO_ROOT, 'src/renderer/components/onboarding/walkthrough-steps.ts');
const UI_SPEC_FILE = path.join(REPO_ROOT, 'tests/ui/onboarding-walkthrough.spec.ts');
const RENDERER_DIR = path.join(REPO_ROOT, 'src/renderer');

function readFile(filePath: string): string {
  return fs.readFileSync(filePath, 'utf8');
}

/**
 * Every .tsx/.ts file under src/renderer EXCEPT the step definitions themselves.
 *
 * Excluding that one file is load-bearing, not tidiness: the selectors live there as
 * string literals, so including it makes every id match itself and the whole check passes
 * vacuously no matter how broken the selector is. Verified by pointing a step at a
 * nonexistent id and watching this fail.
 */
function readRendererSources(): string {
  const collected: string[] = [];
  const walk = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(entryPath);
      else if (entryPath === STEPS_FILE) continue;
      else if (entry.name.endsWith('.tsx') || entry.name.endsWith('.ts')) {
        collected.push(fs.readFileSync(entryPath, 'utf8'));
      }
    }
  };
  walk(RENDERER_DIR);
  return collected.join('\n');
}

/** Drop comments so assertions read the CODE, not prose about it. The step definitions
 *  deliberately discuss the name-based-selector bug they exist to avoid, and a naive scan
 *  would flag that explanation as the offence. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const stepsSource = readFile(STEPS_FILE);
const stepsCode = stripComments(stepsSource);

/** Test ids the walkthrough's target selectors depend on. */
function referencedTestIds(): string[] {
  return Array.from(stepsCode.matchAll(/\[data-testid="([^"]+)"\]/g)).map((match) => match[1]);
}

/** Step keys declared in WALKTHROUGH_STEPS, in declaration order. */
function declaredStepKeys(): string[] {
  return Array.from(stepsCode.matchAll(/^\s*key: '([^']+)',$/gm)).map((match) => match[1]);
}

describe('walkthrough target parity', () => {
  it('names at least one target test id and one step (the scan is not silently empty)', () => {
    // Guards the guard: a refactor that changed how selectors are written would otherwise
    // make every assertion below pass vacuously.
    expect(referencedTestIds().length).toBeGreaterThan(0);
    expect(declaredStepKeys().length).toBeGreaterThan(0);
  });

  it('every test id a step points at still exists in the renderer', () => {
    const rendererSource = readRendererSources();
    const missing = referencedTestIds().filter((testId) => {
      // Either a literal attribute, or a `testId` prop that a shared component (Combobox,
      // BaseDialog) forwards to data-testid.
      const asAttribute = `data-testid="${testId}"`;
      const asProp = `testId="${testId}"`;
      return !rendererSource.includes(asAttribute) && !rendererSource.includes(asProp);
    });
    expect(
      missing,
      `The onboarding walkthrough rings these by selector, but nothing in src/renderer renders them any more. `
      + `A step whose target does not resolve renders NOTHING - it fails silently. Update the selector in `
      + `walkthrough-steps.ts, or restore the test id.`,
    ).toEqual([]);
  });

  it('resolves board columns by id, never by the name a user can change', () => {
    // The seeded "Planning" column is renameable, and step 2 actively invites renaming it.
    // A name-based lookup would break for exactly the users who did what the checklist
    // asked. This already shipped once as a [data-swimlane-name="Backlog"] selector that
    // matched nothing.
    expect(stepsCode).not.toMatch(/data-swimlane-name=/);
    expect(stepsCode).toMatch(/data-swimlane-id=/);
  });

  it('every declared step is exercised by the UI spec', () => {
    // The UI spec is what proves a target actually RENDERS once its surface opens - the
    // failure mode a static scan cannot see (a setting moved to a different settings tab
    // keeps its test id and still resolves nowhere). A new step must not slip in without
    // that coverage.
    const uiSpecSource = readFile(UI_SPEC_FILE);
    const uncovered = declaredStepKeys().filter((key) => !uiSpecSource.includes(key));
    expect(
      uncovered,
      'These walkthrough steps have no UI-tier coverage. Add a test that activates the step '
      + 'and asserts its spotlight resolves, so a moved or restructured view fails loudly.',
    ).toEqual([]);
  });
});
