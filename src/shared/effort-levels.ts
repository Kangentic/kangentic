import type { AgentCapabilities } from './types';

/**
 * The effort levels a run on `model` may pass: the model's own levels when the
 * CLI reports levels per model (`effortLevelsByModel`), else the agent's
 * `effortLevels`. Shared by the settings rows that offer a level and the main
 * process paths that check one before a run, so the two cannot disagree.
 *
 * The model is free text when the CLI lists none, so a name such as
 * `constructor` would read an inherited member of the map; only an array is
 * taken as the model's levels.
 */
export function effortLevelsForModel(
  capabilities: Pick<AgentCapabilities, 'effortLevels' | 'effortLevelsByModel'> | null | undefined,
  model: string | null | undefined,
): string[] {
  const byModel = model ? capabilities?.effortLevelsByModel?.[model] : undefined;
  return Array.isArray(byModel) ? byModel : (capabilities?.effortLevels ?? []);
}
