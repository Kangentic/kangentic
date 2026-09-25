/**
 * The Ask harness spends real subscription quota, so it must stay something a
 * person runs deliberately - never a step in a pipeline.
 *
 * That is easy to state and easy to erode: someone adds `"eval": "node
 * scripts/eval-ask.mjs"` to package.json as a convenience, a workflow picks up
 * `npm run eval`, and a pull request quietly costs ten agent calls per push. By
 * the time anyone notices, it has been billing for weeks.
 *
 * So the rule is enforced from three directions rather than trusted:
 *   1. this scan, which fails if anything automated references the runner,
 *   2. the runner's own `refuseIfAutomated`, which exits under CI even if the
 *      wiring gets past the scan,
 *   3. an entry-point guard, so importing the module (as the self-check test
 *      does) cannot execute a run.
 *
 * `--dry` and `--regrade` are exempt in the runner because they spend nothing;
 * this scan does not need to know about that distinction, since the concern
 * here is anything invoking the harness at all from an automated path.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const RUNNER = 'eval-ask';

/** Every file that could cause the harness to run without a person asking. */
function automatedSurfaces(): Array<{ label: string; text: string }> {
  const surfaces: Array<{ label: string; text: string }> = [];

  const packageJson = path.join(ROOT, 'package.json');
  const manifest = JSON.parse(fs.readFileSync(packageJson, 'utf-8')) as {
    scripts?: Record<string, string>;
  };
  surfaces.push({ label: 'package.json scripts', text: JSON.stringify(manifest.scripts ?? {}) });

  const workflows = path.join(ROOT, '.github', 'workflows');
  if (fs.existsSync(workflows)) {
    for (const entry of fs.readdirSync(workflows)) {
      surfaces.push({
        label: `.github/workflows/${entry}`,
        text: fs.readFileSync(path.join(workflows, entry), 'utf-8'),
      });
    }
  }

  const playwright = path.join(ROOT, 'playwright.config.ts');
  if (fs.existsSync(playwright)) {
    surfaces.push({ label: 'playwright.config.ts', text: fs.readFileSync(playwright, 'utf-8') });
  }
  return surfaces;
}

describe('the Ask harness runs on demand only', () => {
  it('is referenced by no npm script, workflow, or test runner config', () => {
    const offenders = automatedSurfaces()
      .filter((surface) => surface.text.includes(RUNNER))
      .map((surface) => surface.label);
    expect(offenders, `${RUNNER} must not be reachable from an automated path`).toEqual([]);
  });

  it('is invoked by no test in the suite', () => {
    // The self-check imports the module for its pure halves, which is fine and
    // is why this looks for an INVOCATION rather than a mention.
    const offenders: string[] = [];
    for (const tier of ['unit', 'ui', 'e2e']) {
      const directory = path.join(ROOT, 'tests', tier);
      if (!fs.existsSync(directory)) continue;
      for (const entry of fs.readdirSync(directory)) {
        if (!entry.endsWith('.ts')) continue;
        const text = fs.readFileSync(path.join(directory, entry), 'utf-8');
        // A spawn, exec, or shell invocation naming the runner.
        if (/(?:spawn|exec|execSync|execa|run)\s*\([^)]*eval-ask/.test(text)) {
          offenders.push(`tests/${tier}/${entry}`);
        }
      }
    }
    expect(offenders, 'no test may spend agent quota by running the harness').toEqual([]);
  });

  it('refuses to run when a CI environment variable is set', async () => {
    // The backstop for wiring this scan cannot see - a developer machine with
    // CI set, a runner this repo does not know about, a script invoked by path.
    const harness = await import('../../scripts/eval-ask.mjs');
    const previous = process.env.CI;
    process.env.CI = 'true';
    try {
      expect(() => harness.__testing.refuseIfAutomated(true)).toThrow(/Refusing to run/);
      // ...and the free modes stay usable, since they cost nothing.
      expect(() => harness.__testing.refuseIfAutomated(false)).not.toThrow();
    } finally {
      if (previous === undefined) delete process.env.CI;
      else process.env.CI = previous;
    }
  });
});
