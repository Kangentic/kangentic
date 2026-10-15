import type { Task } from '../../../shared/types';
import { buildTaskXml, escapeXml } from './prompt-xml';
import { INLINE_PROMPT_BUDGET, commandLineLength, fitCommandLine } from './prompt-budget';

/** A description longer than this is cut in the recap: the task is in Kangentic for the agent to read whole. */
const DESCRIPTION_MAX_CHARS = 1_800;
/** A title longer than this is cut, so the fixed parts always fit and the closing is never what is lost. */
const TITLE_MAX_CHARS = 300;
/** The branch block's lines, cut at this many characters. */
const GIT_BLOCK_MAX_CHARS = 1_400;
/** Below this, the old conversation's tail is not worth asking the worker for. */
const TAIL_MIN_CHARS = 400;
/**
 * Passes that cut the description further when escaping lengthened it past the
 * budget. Each pass cuts by the overrun plus `ESCAPE_SLACK`, and a cut can end
 * mid-entity, so one pass is not always enough.
 */
const MAX_DESCRIPTION_CUTS = 3;
const ESCAPE_SLACK = 16;
const TAIL_WRAPPER = '<previous_conversation_tail>\n\n</previous_conversation_tail>\n\n';

/** The working tree's state, read in the task's own checkout. */
export interface RecapGitState {
  branch: string | null;
  /** `git log --oneline <base>..HEAD`, newest first. */
  commits: string[];
  /** `git status --short` lines. */
  changes: string[];
}

/**
 * Where the recap's optional parts come from. Each may be absent and each may
 * answer null; the recap is built from whatever answered. The sources own their
 * own time limits, since one of them is a call to another process.
 */
export interface ExpiredConversationRecapSources {
  /** The task's written summary from the index, if one exists. */
  readTaskSummary?(taskId: string): Promise<string | null>;
  /**
   * The newest turns of the old conversation as plain text, at most `maxChars`
   * long, newest kept. Read from Kangentic's saved copy of it, since the
   * agent's own file is gone.
   */
  readConversationTail?(agentSessionId: string, maxChars: number): Promise<string | null>;
  readGitState?(cwd: string, baseBranch: string): Promise<RecapGitState | null>;
}

export interface ExpiredConversationRecapInput {
  task: Pick<Task, 'id' | 'title' | 'description' | 'pr_url'>;
  /** The agent that deleted the conversation, by its display name. */
  agentDisplayName: string;
  previousAgentSessionId: string;
  /** When the old conversation last ran, as a UTC ISO timestamp. */
  lastActiveAt: string | null;
  cwd: string;
  /** The task's effective base branch. */
  baseBranch: string;
  /**
   * `whole-prompt`: the recap is the new session's only prompt, so it carries
   * the task itself and ends by asking for a summary, then a wait. The task's
   * main session uses it: a conversation old enough to expire belongs to a
   * stale task, and the column's command would act on a state nobody has
   * looked at in a month.
   *
   * `context`: the recap is prepended to the column's own prompt, which
   * carries the task and the instruction. An isolated column set to keep its
   * own conversation uses it: that conversation being old says the column's
   * pass is old, not that the task is.
   */
  mode: 'whole-prompt' | 'context';
  /**
   * Command-line characters the caller's own text takes beside the recap (the
   * column's prompt in `context` mode, a handoff pointer), measured with
   * `commandLineLength`. The recap's optional parts fit in what is left.
   */
  reservedChars?: number;
}

/**
 * The opening prompt of a session started in place of a resume whose
 * conversation the agent deleted (Claude Code removes transcripts older than
 * `cleanupPeriodDays`). It says what happened, then hands over what Kangentic
 * still holds: the task, its summary, the old conversation's last turns, and
 * the branch.
 *
 * It rides the command line, so it is measured as cmd.exe receives it
 * (`commandLineLength`) against `INLINE_PROMPT_BUDGET` less the caller's
 * `reservedChars`. The fixed parts always fit; the summary and the branch go in
 * while they fit, and the old conversation's tail gets whatever is left.
 */
export async function buildExpiredConversationRecap(
  input: ExpiredConversationRecapInput,
  sources: ExpiredConversationRecapSources = {},
): Promise<string> {
  const budget = Math.max(0, INLINE_PROMPT_BUDGET - (input.reservedChars ?? 0));
  const lastActiveDate = input.lastActiveAt ? input.lastActiveAt.slice(0, 10) : null;
  const header = [
    lastActiveDate
      ? `Your previous conversation on this task was last active on ${lastActiveDate}.`
      : 'You had a previous conversation on this task.',
    `${input.agentDisplayName} deleted it after its retention period, so it cannot be resumed, and this is a new conversation.`,
    input.mode === 'whole-prompt'
      ? 'Below is what Kangentic still holds about the task.'
      : 'Below is what Kangentic still holds about the task, for context.',
  ].join(' ');
  let descriptionCap = DESCRIPTION_MAX_CHARS;
  const title = truncateEnd(input.task.title, TITLE_MAX_CHARS);
  const buildTaskBlock = (): string | null => (input.mode === 'whole-prompt'
    ? buildTaskXml({ title, description: truncateEnd(input.task.description ?? '', descriptionCap) })
    : null);
  // By the old conversation's id: a call by task id reads the task's NEWEST
  // session, which is this new one. No quotes around the id: a double-quoted
  // shell gets its prompt's double quotes rewritten (command-builder.ts).
  const pointer = `Read the previous conversation with the kangentic_get_transcript tool, passing sessionId ${escapeXml(input.previousAgentSessionId)}.`;
  // No apostrophe: a unix-like host quotes the prompt in single quotes, and
  // nushell has no escape for one inside them.
  const closing = input.mode === 'whole-prompt'
    ? 'Reply with a short summary of where the work stands, then wait for the next instruction from the user.'
    : null;

  const blocks: RecapBlocks = {
    header,
    taskBlock: buildTaskBlock(),
    summaryBlock: null,
    tailBlock: null,
    gitBlock: null,
    pointer,
    closing,
  };
  const lengthOf = (): number => commandLineLength(assemble(blocks));
  // The fixed parts fit before any source is read: a description whose
  // escaping overran the budget is cut further, so the closing instruction is
  // never the part lost.
  for (let cut = 0; cut < MAX_DESCRIPTION_CUTS && lengthOf() > budget; cut += 1) {
    descriptionCap = Math.max(0, descriptionCap - (lengthOf() - budget) - ESCAPE_SLACK);
    blocks.taskBlock = buildTaskBlock();
  }

  // All three reads at once: the tail is asked for the most room it could get
  // and cut to what the summary and the branch leave, so one slow source costs
  // its own wait, not the sum of them.
  const tailRoomAtMost = budget - lengthOf() - TAIL_WRAPPER.length;
  const [summary, gitState, tail] = await Promise.all([
    readSafely(() => sources.readTaskSummary?.(input.task.id)),
    readSafely(() => sources.readGitState?.(input.cwd, input.baseBranch)),
    tailRoomAtMost >= TAIL_MIN_CHARS && sources.readConversationTail
      ? readSafely(() => sources.readConversationTail!(input.previousAgentSessionId, tailRoomAtMost))
      : Promise.resolve(null),
  ]);

  // The summary and the branch go in only while they fit.
  const summaryText = summary ? withoutControlCharacters(summary).trim() : '';
  blocks.summaryBlock = summaryText ? `<task_summary>\n${escapeXml(summaryText)}\n</task_summary>` : null;
  if (lengthOf() > budget) blocks.summaryBlock = null;
  blocks.gitBlock = buildGitBlock(gitState, input.baseBranch, input.task.pr_url);
  if (lengthOf() > budget) blocks.gitBlock = null;

  // The tail gets what is left, and only when that is worth a block.
  const tailRoom = budget - lengthOf() - TAIL_WRAPPER.length;
  const tailText = tail ? withoutControlCharacters(tail).trim() : '';
  if (tailRoom >= TAIL_MIN_CHARS && tailText) {
    // Escaping can lengthen the text, so cut after it, from the start: the
    // newest turns are the ones worth keeping.
    const escaped = fitCommandLine(escapeXml(tailText), tailRoom, 'end');
    blocks.tailBlock = `<previous_conversation_tail>\n${escaped}\n</previous_conversation_tail>`;
  }

  // Whatever a source returned, the recap never passes the inline budget.
  return fitCommandLine(assemble(blocks), INLINE_PROMPT_BUDGET, 'start');
}

interface RecapBlocks {
  header: string;
  taskBlock: string | null;
  summaryBlock: string | null;
  tailBlock: string | null;
  gitBlock: string | null;
  pointer: string;
  closing: string | null;
}

function assemble(blocks: RecapBlocks): string {
  return [
    blocks.header,
    blocks.taskBlock,
    blocks.summaryBlock,
    blocks.tailBlock,
    blocks.gitBlock,
    blocks.pointer,
    blocks.closing,
  ].filter((block): block is string => block !== null && block.length > 0).join('\n\n');
}

function buildGitBlock(state: RecapGitState | null, baseBranch: string, prUrl: string | null): string | null {
  if (!state && !prUrl) return null;
  const lines: string[] = [];
  if (state?.branch) lines.push(`Branch: ${state.branch}, based on ${baseBranch}`);
  if (prUrl) lines.push(`Pull request: ${prUrl}`);
  if (state && state.commits.length > 0) {
    lines.push('Commits on this branch:');
    lines.push(...state.commits);
  } else if (state) {
    lines.push(`No commits on this branch beyond ${baseBranch}.`);
  }
  if (state && state.changes.length > 0) {
    lines.push('Uncommitted changes:');
    lines.push(...state.changes);
  }
  if (lines.length === 0) return null;
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    const escaped = escapeXml(line);
    if (used + escaped.length + 1 > GIT_BLOCK_MAX_CHARS) break;
    kept.push(escaped);
    used += escaped.length + 1;
  }
  // A first line longer than the block would leave it empty, which costs room and says nothing.
  if (kept.length === 0) return null;
  return `<branch_state>\n${kept.join('\n')}\n</branch_state>`;
}

/**
 * Conversation and summary text as it may be typed into the spawning shell:
 * line breaks kept, a tab as a space (a tab completes in bash, zsh and fish,
 * even inside quotes), and every other control character dropped (an escape
 * from a pasted terminal log, a Ctrl+C, a bare carriage return, which is Enter).
 * Never longer than the input, so a tail cut to its room still fits.
 */
function withoutControlCharacters(text: string): string {
  let kept = '';
  for (const character of text.replace(/\r\n/g, '\n')) {
    const code = character.charCodeAt(0);
    if (character === '\t') kept += ' ';
    else if (character === '\n' || (code >= 0x20 && code < 0x7f) || code > 0x9f) kept += character;
  }
  return kept;
}

async function readSafely<Result>(read: () => Promise<Result | null> | undefined): Promise<Result | null> {
  try {
    return (await read()) ?? null;
  } catch (error) {
    console.warn('[expired-recap] A recap source failed:', error instanceof Error ? error.message : error);
    return null;
  }
}

function truncateEnd(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, Math.max(0, maxChars - 3))}...`;
}
