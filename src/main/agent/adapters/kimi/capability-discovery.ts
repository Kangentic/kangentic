/**
 * Kimi Code CLI capability discovery: the `--model` flag, the model aliases
 * the user's CLI has configured, and the thinking efforts those models take.
 *
 * Sources (Kimi Code CLI 2.4.1, read 2026-11-03):
 * - `en/reference/kimi-command.md`: `-m, --model <model>` takes a model
 *   alias, a key in `config.toml`'s `[models]`. There is no command that lists
 *   models, so the aliases come from the config file (`config-toml.ts`).
 * - `en/configuration/config-files.md`: a model's `support_efforts` lists
 *   the thinking efforts it accepts.
 * - `en/configuration/env-vars.md`: `KIMI_MODEL_THINKING_EFFORT` sets a
 *   session's effort (the adapter's `buildEnv`); there is no effort flag.
 *
 * `--help` is safe to run on any install (a bare `kimi` on the archived 1.52
 * stub of kimi-cli starts a remote installer, so nothing here runs it bare).
 * Built from the docs, not yet checked against a real install.
 */

import { execAsync, execFileAsync } from '../../../utility-process/off-main-exec';
import { quoteCmdExecutable } from '../../../../shared/shell-quote';
import { execCliForTarget, resolveCliTarget, type CliTarget } from '../../shared/cli-target';
import type { AgentCapabilities } from '../../../../shared/types';
import { readKimiCodeConfig, type KimiCodeConfig } from './config-toml';

const HELP_TIMEOUT_MS = 5000;

/** `<cliPath> --help`; a Kimi Code in a WSL distro runs there, through `wsl.exe`. */
async function readHelpText(cliPath: string, target: CliTarget | null): Promise<string> {
  if (target) {
    const { stdout } = await execCliForTarget(target, ['--help'], { timeout: HELP_TIMEOUT_MS, maxBuffer: 1024 * 1024 });
    return stdout;
  }
  if (process.platform === 'win32') {
    const { stdout } = await execAsync(`${quoteCmdExecutable(cliPath)} --help`, {
      timeout: HELP_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    return stdout;
  }
  const { stdout } = await execFileAsync(cliPath, ['--help'], { timeout: HELP_TIMEOUT_MS, maxBuffer: 1024 * 1024 });
  return stdout;
}

/** True when the help text names a model flag (`-m, --model <model>`). */
export function helpTextHasModelFlag(helpText: string): boolean {
  return /(?:^|\s)--model\b/m.test(helpText);
}

/** The capabilities a config reports: its aliases, their names and their efforts. */
export function capabilitiesFromConfig(config: KimiCodeConfig, supportsModelOverride: boolean): AgentCapabilities {
  const models = config.models.map((model) => model.alias);
  const modelDisplayNames: Record<string, string> = {};
  for (const model of config.models) {
    if (model.displayName) modelDisplayNames[model.alias] = model.displayName;
  }
  const effortLevels: string[] = [];
  for (const model of config.models) {
    for (const effort of model.supportEfforts) {
      if (!effortLevels.includes(effort)) effortLevels.push(effort);
    }
  }
  return {
    supportsModelOverride,
    models: supportsModelOverride && models.length > 0 ? models : undefined,
    modelDisplayNames: Object.keys(modelDisplayNames).length > 0 ? modelDisplayNames : undefined,
    effortLevels,
  };
}

/**
 * Discover Kimi Code's capabilities. Never throws: a failed probe reports no
 * model flag, and an unreadable config reports no models.
 */
export async function discoverKimiCapabilities(cliPath: string): Promise<AgentCapabilities> {
  const target = await resolveCliTarget(cliPath, true).catch(() => null);
  const helpText = await readHelpText(cliPath, target).catch(() => '');
  return capabilitiesFromConfig(readKimiCodeConfig(target), helpTextHasModelFlag(helpText));
}
