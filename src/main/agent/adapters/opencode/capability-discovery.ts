/**
 * OpenCode capability discovery: detect available models and model override support.
 *
 * OpenCode is an agentic framework with per-mode autonomy (Plan/Build agents).
 * Model overrides via CLI flags may not be available; user preference ("CLI
 * features over Kangentic custom layers") suggests letting the TUI/config
 * handle model selection rather than shadowing it with per-spawn flags.
 *
 * Research needed: does OpenCode have a `--model` flag at all?
 * For now, return supportsModelOverride: false to hide the dropdown.
 */

import { execAsync, execFileAsync } from '../../../utility-process/off-main-exec';
import { execCliForTarget, resolveCliTarget, type CliTarget } from '../../shared/cli-target';
import { quoteCmdExecutable } from '../../../../shared/shell-quote';
import type { AgentCapabilities } from '../../../../shared/types';
import { isOpenCodeV2 } from './version';


const HELP_TIMEOUT_MS = 5000;

/**
 * Run `<cliPath> --help` and capture stdout.
 * On Windows, use shell invocation; on Unix, use direct execFile. An OpenCode
 * installed in a WSL distro (`target`) runs there, through `wsl.exe`.
 */
async function readHelpText(cliPath: string, target: CliTarget | null): Promise<string> {
  if (target) return (await execCliForTarget(target, ['--help'], { timeout: HELP_TIMEOUT_MS, maxBuffer: 1024 * 1024 })).stdout;
  if (process.platform === 'win32') {
    const { stdout } = await execAsync(`${quoteCmdExecutable(cliPath)} --help`, {
      timeout: HELP_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    return stdout;
  }
  const { stdout } = await execFileAsync(cliPath, ['--help'], {
    timeout: HELP_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
  });
  return stdout;
}

/**
 * Discover OpenCode's capabilities. OpenCode uses per-mode autonomy
 * (Plan/Build agents) rather than model/effort, so model override
 * support is likely limited. Returns supportsModelOverride: false
 * to let the TUI/config handle model selection.
 *
 * OpenCode 2's root help has no `--model` at all: its TUI takes the model
 * from config, and a V2 spawn sets it there (`buildOpenCodeEnv`). So a V2
 * CLI (`cliVersion`) supports the override without reading its help.
 */
export async function discoverOpenCodeCapabilities(cliPath: string, cliVersion?: string | null): Promise<AgentCapabilities> {
  if (isOpenCodeV2(cliVersion)) return { supportsModelOverride: true, effortLevels: [] };
  // Best-effort: try to detect --model flag, but default to false
  let supportsModelOverride = false;
  try {
    const helpText = await readHelpText(cliPath, await resolveCliTarget(cliPath, true));
    supportsModelOverride = /--model\s+<|--model\s+[A-Za-z]|-m\s+<|-m\s+[A-Za-z]/.test(helpText);
  } catch {
    // Help parsing failure - default to false
  }

  return {
    supportsModelOverride,
    // OpenCode has no effort/reasoning levels
    effortLevels: [],
  };
}
