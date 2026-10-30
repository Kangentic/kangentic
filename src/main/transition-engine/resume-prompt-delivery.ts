import type { AgentAdapter } from '../agent/agent-adapter';
import type { ShimLaunchStrategy } from '../agent/shared/shim-launch';
import { commandLineLength } from '../agent/shared/prompt-budget';
import { quoteArgKeepsNewlines } from '../../shared/paths';

/**
 * The longest resume prompt that rides the CLI's command line, by
 * `commandLineLength` (what the prompt takes up under cmd.exe, whose `%`
 * escape grows it). A longer one is typed in once the agent is ready instead.
 *
 * cmd.exe cuts a command line at 8,191 characters, the whole line, and the
 * rest of a resume command (the CLI's path, its settings, hook and MCP flags)
 * takes up to about 1,500 of them. A Move to column message is often a
 * reviewer's whole reply, so this cap is reachable. The typed path pastes any
 * length whole.
 */
export const RESUME_PROMPT_COMMAND_LINE_CAP = 6_000;

/**
 * Whether a resume's prompt can ride its command line, or has to be typed in
 * once the agent is ready.
 *
 * It rides only when all of these hold:
 * - the adapter's resume command carries a prompt;
 * - a multi-line prompt keeps its lines. A `.cmd` shim under PowerShell or Git
 *   Bash flattens one (`flattened-prompt`), and so does a cmd.exe shell, or no
 *   known shell, at quoting (`quoteArgKeepsNewlines`). Flattened, a numbered
 *   list of held messages runs together;
 * - it does not open with `-`, which a CLI with no `--` before its positional
 *   prompt would read as an option and fail to start;
 * - it fits under the cap.
 */
export function resumePromptRidesCommandLine(input: {
  delivery: AgentAdapter['resumePromptDelivery'];
  prompt: string;
  launchStrategy: ShimLaunchStrategy;
  shell: string | undefined;
}): boolean {
  if (input.delivery !== 'command-line') return false;
  if (/[\r\n]/.test(input.prompt)
    && (input.launchStrategy === 'flattened-prompt' || !quoteArgKeepsNewlines(input.shell))) return false;
  if (input.prompt.startsWith('-')) return false;
  return commandLineLength(input.prompt) <= RESUME_PROMPT_COMMAND_LINE_CAP;
}
