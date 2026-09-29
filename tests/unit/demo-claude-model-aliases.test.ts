/**
 * The sample install's Claude model fields, which the web demo and the marketing captures both
 * seed. The pickers read three things from them: the version list, the floating aliases, and the
 * display names. They are built by hand in demo-dataset.ts, so nothing but this test notices the
 * three drifting apart (an alias whose target is not in the list would render a "Latest" row that
 * points at nothing, and a column pinned to an id the list lacks would lose its label).
 */
import { describe, expect, it } from 'vitest';
import { DEMO_AGENT_OVERRIDES, DEMO_COLUMN_MODELS } from '../../tests/captures/helpers/demo-dataset';
import { parseModelFamily, parseModelId } from '../../src/shared/model-id';
import type { AgentCapabilities } from '../../src/shared/types';

const claudeCapabilities = DEMO_AGENT_OVERRIDES.claude.capabilities as Pick<
  AgentCapabilities,
  'models' | 'modelAliases' | 'modelDisplayNames'
>;

describe('demo dataset Claude model fields', () => {
  it('offers floating aliases, and every alias resolves to a model in the list', () => {
    const aliases = claudeCapabilities.modelAliases ?? [];
    // Vacuity guard: the web demo's "Latest" group needs at least one alias to render.
    expect(aliases.length).toBeGreaterThan(0);
    for (const alias of aliases) {
      expect(alias.resolvesTo, `alias ${alias.id} names no target`).toBeDefined();
      expect(claudeCapabilities.models, `alias ${alias.id} -> ${alias.resolvesTo}`).toContain(alias.resolvesTo);
    }
  });

  it('keeps aliases out of the version list, since the pickers fold an alias id into its own row', () => {
    const aliasIds = new Set((claudeCapabilities.modelAliases ?? []).map((alias) => alias.id));
    for (const id of claudeCapabilities.models ?? []) {
      expect(aliasIds.has(id), `${id} is both an alias and a version`).toBe(false);
    }
  });

  it('names every alias and every model, so a column on either reads as on the desktop', () => {
    const names = claudeCapabilities.modelDisplayNames ?? {};
    for (const alias of claudeCapabilities.modelAliases ?? []) {
      expect(names[alias.id], `no display name for alias ${alias.id}`).toBeTruthy();
    }
    for (const id of claudeCapabilities.models ?? []) {
      expect(names[id], `no display name for ${id}`).toBeTruthy();
    }
    expect(names.opus).toBe('Opus');
  });

  it('lists the models the demo columns are pinned to, so their labels resolve', () => {
    expect(claudeCapabilities.models).toContain(DEMO_COLUMN_MODELS.opus);
    expect(claudeCapabilities.models).toContain(DEMO_COLUMN_MODELS.sonnet);
  });

  it('gives each alias one family, matching a listed version of that family', () => {
    const families = new Set<string>();
    for (const alias of claudeCapabilities.modelAliases ?? []) {
      expect(families.has(alias.id), `duplicate alias ${alias.id}`).toBe(false);
      families.add(alias.id);
      const resolvedFamily = parseModelFamily(parseModelId(alias.resolvesTo ?? '').baseId).family;
      expect(resolvedFamily, `alias ${alias.id} resolves outside its family`).toBe(`claude-${alias.id}`);
    }
  });
});
