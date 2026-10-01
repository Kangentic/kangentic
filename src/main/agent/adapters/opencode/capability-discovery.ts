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
import type { AgentCapabilities } from '../../../../shared/types';


const HELP_TIMEOUT_MS = 5000;

/**
 * Run `<cliPath> --help` and capture stdout.
 * On Windows, use shell invocation; on Unix, use direct execFile.
 */
async function readHelpText(cliPath: string): Promise<string> {
  if (process.platform === 'win32') {
    const { stdout } = await execAsync(`"${cliPath}" --help`, {
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
 */
export async function discoverOpenCodeCapabilities(cliPath: string): Promise<AgentCapabilities> {
  // Best-effort: try to detect --model flag, but default to false
  let supportsModelOverride = false;
  try {
    const helpText = await readHelpText(cliPath);
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
