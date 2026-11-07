import type { AgentAdapter } from '../agent/agent-adapter';
import type { ShimLaunchStrategy } from '../agent/shared/shim-launch';
import { commandLineLength } from '../agent/shared/prompt-budget';
import { quoteArgKeepsNewlines } from '../../shared/paths';
import { isSlashCommand } from '../automations/turn-end/agent-message-delivery';
import { commandLineLimit, launchRunsOnLinux, LINUX_ARGUMENT_BYTE_LIMIT } from '../pty/spawn/typed-launch';

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
 * What a fresh launch's command takes up besides its prompt: the CLI's path, its
 * settings, hook and MCP flags. Claude's is the longest, measured at 1,524
 * characters on Windows-length paths with an MCP server and the Agent Browser on.
 * `task-description-limit.test.ts` builds every adapter's command against this.
 */
export const COMMAND_LINE_RESERVE = 2_500;

/**
 * Everything a spawn left for its caller to type in, for a caller that sends it
 * as one delivery: the opening first, then the message it left out. Null when
 * the spawn's command carried it all.
 */
export function textLeftToType(outcome: { typedOpening?: string | null; unsentPrompt: string | null } | undefined): string | null {
  const pieces = [outcome?.typedOpening, outcome?.unsentPrompt].filter((piece): piece is string => Boolean(piece?.trim()));
  return pieces.length > 0 ? pieces.join('\n\n') : null;
}

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

/**
 * What a prompt takes up in a command quoted for a Linux shell, in bytes: bash
 * writes `'` as `'\''`, and fish and nushell escape `"`, `\` and a line break.
 */
function quotedPromptBytes(prompt: string): number {
  const apostrophes = prompt.match(/'/g)?.length ?? 0;
  const escaped = prompt.match(/["\\\n]/g)?.length ?? 0;
  return Buffer.byteLength(prompt, 'utf8') + apostrophes * 3 + escaped;
}

/**
 * Whether a fresh launch's prompt fits its command line, by the limit the spawn
 * refuses at (`commandFitsShell`), less the rest of the command. `commandLineLength`
 * counts what the prompt grows to under cmd.exe, and a `"` counts for two, which
 * covers a Git Bash launch of a Windows program.
 */
export function freshPromptRidesCommandLine(input: {
  prompt: string;
  agentPath: string;
  shell: string;
  platform: NodeJS.Platform;
}): boolean {
  if (launchRunsOnLinux(input)) return quotedPromptBytes(input.prompt) <= LINUX_ARGUMENT_BYTE_LIMIT - COMMAND_LINE_RESERVE;
  const limit = commandLineLimit({ program: input.agentPath, shell: input.shell, platform: input.platform });
  if (limit === null) return true;
  const quotes = input.prompt.match(/"/g)?.length ?? 0;
  return commandLineLength(input.prompt) + quotes <= limit - COMMAND_LINE_RESERVE;
}

/**
 * Whether a fresh start's prompt is kept off its command for its length, to be
 * typed in. A prompt too long for the line is typed only into an agent whose input
 * box can be told from a boot screen (`firstPromptMayBeTyped`), whose Enter it
 * would otherwise answer. A slash command runs only as keystrokes, too slow for a
 * prompt this long. Anything else stays on the command, and the spawn refuses it
 * (`AgentCommandTooLongError`).
 */
export function freshPromptTypedForLength(input: {
  prompt: string;
  /** `firstPromptMayBeTyped`'s answer for this launch. */
  mayBeTyped: boolean;
  agentPath: string;
  shell: string;
}): boolean {
  return input.mayBeTyped && !isSlashCommand(input.prompt)
    && !freshPromptRidesCommandLine({ prompt: input.prompt, agentPath: input.agentPath, shell: input.shell, platform: process.platform });
}
