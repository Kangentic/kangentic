/**
 * Guards the ESLint 9 -> 10 migration decision in eslint.config.mjs: the
 * config extends `eslint-plugin-react-hooks`'s `recommended-latest` flat
 * preset (which ships `rules-of-hooks`, `exhaustive-deps`, and the React
 * Compiler rules) rather than wiring `react-hooks/rules-of-hooks` and
 * `react-hooks/exhaustive-deps` by hand, as the pre-migration config did.
 *
 * `npm run lint` cannot catch a regression here: dropping the `extends:`
 * entry (or the whole `files` block) makes lint pass with FEWER rules
 * active, not with a new failure. This resolves the config the way ESLint
 * itself does (`ESLint#calculateConfigForFile`, not a source-text regex),
 * so it catches "the preset is listed but resolves empty" (a typo'd config
 * key name), which a text match on `extends:` would miss entirely.
 *
 * The compiler rules are the part a hand-wired config would silently lose,
 * so `refs` and `set-state-in-effect` are pinned alongside the two classic
 * rules: a config that only re-adds `rules-of-hooks` + `exhaustive-deps`
 * by hand must fail here.
 *
 * Tier: Unit (pure config resolution, no build).
 */
import { describe, it, expect } from 'vitest';
import { ESLint } from 'eslint';

const PINNED_RULES = [
  'react-hooks/rules-of-hooks',
  'react-hooks/exhaustive-deps',
  'react-hooks/refs',
  'react-hooks/set-state-in-effect',
] as const;

// Flat-config rule entries are `[severity, ...options]` or a bare severity; 0 is 'off'.
function severityOf(entry: unknown): number {
  return Array.isArray(entry) ? (entry[0] as number) : (entry as number);
}

async function resolveRulesFor(filePath: string): Promise<Record<string, unknown>> {
  const eslint = new ESLint({ overrideConfigFile: 'eslint.config.mjs' });
  const config = await eslint.calculateConfigForFile(filePath);
  return (config.rules ?? {}) as Record<string, unknown>;
}

describe('eslint.config.mjs react-hooks preset', () => {
  it('resolves the classic and compiler rules as active (not off, not missing) for a renderer .tsx file', async () => {
    const rules = await resolveRulesFor('src/renderer/components/board/KanbanBoard.tsx');
    for (const ruleName of PINNED_RULES) {
      expect(rules[ruleName], ruleName).toBeDefined();
      expect(severityOf(rules[ruleName]), ruleName).toBeGreaterThan(0);
    }
  });

  it('resolves the same rules as active for a tests/**/*.tsx file', async () => {
    const rules = await resolveRulesFor('tests/unit/example.tsx');
    for (const ruleName of PINNED_RULES) {
      expect(rules[ruleName], ruleName).toBeDefined();
      expect(severityOf(rules[ruleName]), ruleName).toBeGreaterThan(0);
    }
  });
});
