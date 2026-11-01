// Anthropic + OpenAI canonical guidance: wrap prompt input data in XML tags
// so the model sees a clear data/instruction boundary. Non-XML-aware agents
// (Aider, Codex) treat the markup as harmless prose; the structured fields
// stay readable. Source: Anthropic prompt-engineering courses, OpenAI docs.

import { MARK_BACKGROUND_SERVICE_TOOL } from '../../../shared/background-shell-hold';
import { WORKFLOW_NEEDS_OWNER_LINE } from '../../../shared/workflow-needs-owner';

// Escapes both quote styles so values are safe inside `"..."` and `'...'`
// attribute values. Anthropic's prompt-engineering guidance lists `'` as one
// of the entities to escape; keeping both also protects future attribute
// emitters that pick the other quote style.
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export interface TaskXmlInput {
  title: string;
  description: string;
}

// Single-line description:
//   <task>
//     <title>...</title>
//     <description>short text</description>
//   </task>
//
// Multi-line description (open and close on their own lines so the close
// tag visually pairs with the opener instead of glueing to the last word):
//   <task>
//     <title>...</title>
//     <description>
//   first paragraph
//
//   second paragraph
//   </description>
//   </task>
//
// Multi-line content is NOT indented - that would mutate the description
// body (e.g. silently breaking a markdown code block by adding a 2-space
// prefix that no longer matches the opening fence). The leading and
// trailing newline added around the content are harmless: agents trim
// whitespace inside element bodies.
//
// Empty optional sections are omitted entirely (no `<description />`) so an
// empty tag never gives the agent a "Got it - what would you like me to do?"
// non-signal. When future fields like <labels> or <acceptance_criteria> are
// added, follow the same omit-when-empty pattern.
export function buildTaskXml(input: TaskXmlInput): string {
  const lines: string[] = ['<task>'];
  lines.push(`  <title>${escapeXml(input.title)}</title>`);
  if (input.description.trim()) {
    // Strip trailing whitespace/newlines so the close tag sits on the next
    // line directly after content - never with a stray blank line between.
    const body = input.description.replace(/\s+$/, '');
    if (body.includes('\n')) {
      lines.push('  <description>');
      lines.push(escapeXml(body));
      lines.push('  </description>');
    } else {
      lines.push(`  <description>${escapeXml(body)}</description>`);
    }
  }
  lines.push('</task>');
  return lines.join('\n');
}

/** What a workflow was made from (`{{brief_xml}}`): the source task's own words and its number. */
export interface BriefXmlInput {
  /** The source task's #N; null for a brief with no task behind it. */
  sourceTaskNumber: number | null;
  title: string;
  description: string;
}

/**
 * The brief a workflow's agent plans from, laid out as `buildTaskXml` lays out
 * a task, since an issue's text can hold `</brief>` or `</workflow_request>`:
 *
 *   <brief>
 *     <source_task>#409</source_task>
 *     <title>...</title>
 *     <description>...</description>
 *   </brief>
 */
export function buildBriefXml(input: BriefXmlInput): string {
  const lines: string[] = ['<brief>'];
  if (input.sourceTaskNumber !== null) lines.push(`  <source_task>#${input.sourceTaskNumber}</source_task>`);
  lines.push(`  <title>${escapeXml(input.title)}</title>`);
  const body = input.description.replace(/\s+$/, '');
  if (body.trim()) {
    if (body.includes('\n')) {
      lines.push('  <description>');
      lines.push(escapeXml(body));
      lines.push('  </description>');
    } else {
      lines.push(`  <description>${escapeXml(body)}</description>`);
    }
  }
  lines.push('</brief>');
  return lines.join('\n');
}

/** What a workflow task's agent is told about its workflow (`{{workflow_xml}}`). */
export interface WorkflowXmlInput {
  title: string;
  /** This task's route: the columns it visits, in order, ending with the board's Done column. */
  route: string[];
  /** The column the task is in as the prompt is built, or null when it cannot be read. */
  column: string | null;
  /**
   * Where approving a plan in `column` moves the task (the next column on its
   * route), or null when `column` does not run the task in plan mode.
   */
  planExitTo: string | null;
  /**
   * The route's columns that run the task in a conversation of their own (an
   * isolated session target); every other column continues the task's main
   * conversation. Absent or empty: every column shares one conversation.
   */
  ownConversation?: string[];
  /** What this task waited for, each already in Done when it starts. */
  waitsFor: Array<{ number: number; title: string; column: string; branch: string | null; prUrl: string | null }>;
  /** What waits for this task, so the agent keeps what they depend on stable. */
  blocks: Array<{ number: number; title: string; column: string }>;
}

/**
 * The `<workflow>` block a workflow task's agent gets after its `<task>`.
 *
 * The facts (its route, its neighbours) are data and escaped. The mechanics are
 * instructions, and they are why the block exists: a workflow task runs with
 * nobody watching, and the END of its turn is what the Automation agent judges.
 * A turn that ends on a progress note reads as "not done" and the task waits
 * at Needs you, so the agent is told to end a turn only with the column's work
 * done or with a question, and to put progress notes beside its next tool call.
 */
export function buildWorkflowXml(input: WorkflowXmlInput): string {
  const lines: string[] = ['<workflow>'];
  lines.push(`  <name>${escapeXml(input.title)}</name>`);
  if (input.route.length > 0) lines.push(`  <route>${escapeXml(input.route.join(', '))}</route>`);
  if (input.column) lines.push(`  <column>${escapeXml(input.column)}</column>`);
  if (input.waitsFor.length > 0) {
    lines.push('  <built_on>');
    for (const blocker of input.waitsFor) {
      const extras = [blocker.branch ? `branch ${blocker.branch}` : null, blocker.prUrl ? `PR ${blocker.prUrl}` : null].filter(Boolean);
      lines.push(`    <task number="${blocker.number}" column="${escapeXml(blocker.column)}">${escapeXml(blocker.title)}${extras.length > 0 ? ` (${escapeXml(extras.join(', '))})` : ''}</task>`);
    }
    lines.push('  </built_on>');
  }
  if (input.blocks.length > 0) {
    lines.push('  <waiting_on_this>');
    for (const dependent of input.blocks) {
      lines.push(`    <task number="${dependent.number}" column="${escapeXml(dependent.column)}">${escapeXml(dependent.title)}</task>`);
    }
    lines.push('  </waiting_on_this>');
  }
  lines.push('  <how_this_runs>');
  lines.push('This task is one step of a workflow that runs without anyone watching. When your turn ends, an agent reads your final message to judge whether this column\'s work is done; if it is, the task moves on to the next column of its route by itself.');
  lines.push('- End your turn only when this column\'s work is done (say what you did in your final message), or when only the owner can settle what you are stuck on. A turn that ends on a progress note stops the workflow until someone notices.');
  // The one wait that stops a workflow task and notifies the owner, matched in
  // code (`src/shared/workflow-needs-owner.ts`). Narrow on purpose: everything
  // else a stalled agent meets, Kangentic nudges it past.
  lines.push(`- Only the owner can settle a change from the plan, something the owner must weigh in on, or a decision between options. For those, end your final message with the line "${WORKFLOW_NEEDS_OWNER_LINE}". Anything else, such as a failing test, a busy machine or a step of your own work, is yours to act on without asking.`);
  lines.push('- Put progress notes in the same message as your next tool call, not at the end of a turn.');
  // A plan column's work ends at the plan's approval, which moves the task on
  // by itself while the conversation carries on. An agent told it may move the
  // task itself read that approval as the cue to do so, and skipped a column.
  if (input.column && input.planExitTo) {
    lines.push(`- ${escapeXml(input.column)} plans the work. Approving your plan moves the task on to ${escapeXml(input.planExitTo)}, so do not move it yourself.`);
  } else {
    lines.push('- When you know this column\'s work is done, you may move the task on yourself with kangentic_move_task, column "next".');
  }
  // Task #952: which columns share this conversation. An Executing agent that
  // knew Testing resumes its chat, and that Code Review does not, left what
  // each needed in the right place.
  const ownConversation = input.ownConversation ?? [];
  if (ownConversation.length > 0) {
    if (input.column && ownConversation.includes(input.column)) {
      lines.push(`- ${escapeXml(input.column)} runs in a conversation of its own. The task's other columns continue its main conversation, which sees only the commits you make and is told your final message, so put in that message what they need to know.`);
    } else {
      const names = ownConversation.map(escapeXml);
      const single = names.length === 1;
      const joined = single ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
      const [runs, its, does] = single ? ['runs', 'its', 'does'] : ['run', 'their', 'do'];
      lines.push(`- ${joined} ${runs} in a conversation of ${its} own and ${does} not see this one. The route's other columns continue this conversation, and are told what those columns did when they come back to it.`);
    }
  }
  if (input.blocks.length > 0) lines.push('- The tasks waiting on this one build on what you change. Keep what they depend on stable.');
  // Conditional, because the tool is offered only to an agent that reports its
  // background commands (`AgentAdapter.backgroundCommands`), and the facts this
  // block is built from do not know the agent.
  lines.push(`- If you leave a background command running after your turn (a dev server, a watcher) and you have the ${MARK_BACKGROUND_SERVICE_TOOL} tool, mark it with that tool, or the task looks busy until it exits.`);
  lines.push('  </how_this_runs>');
  lines.push('</workflow>');
  return lines.join('\n');
}

export interface HandoffXmlInput {
  sourceDisplayName: string;
  sessionFilePath: string | null;
  targetHasMcpAccess: boolean;
}

// Instruction prose stays at top level (matches the browser_context reference
// implementation in src/main/ipc/handlers/browser-payload.ts) so the user's
// directive is the first thing the model sees. Structured pointers go in the
// <handoff_context> envelope underneath.
const SESSION_HISTORY_PATH_ELEMENT = /<session_history_path>([^<]*)<\/session_history_path>/;

function unescapeXml(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * The handoff prompt with its session history path rewritten by `map`: for a
 * receiving CLI in a WSL distro, the path the distro opens the prior
 * session's file by (`cliPathForTarget`). A prompt with no path is unchanged.
 */
export function mapHandoffSessionPath(handoffXml: string, map: (hostPath: string) => string): string {
  return handoffXml.replace(SESSION_HISTORY_PATH_ELEMENT, (_element, escapedPath: string) =>
    `<session_history_path>${escapeXml(map(unescapeXml(escapedPath)))}</session_history_path>`);
}

export function buildHandoffXml(input: HandoffXmlInput): string {
  const lines: string[] = [];
  lines.push(`You are continuing work on this task that was previously handled by ${input.sourceDisplayName}.`);
  if (input.sessionFilePath) {
    lines.push('Read the prior session history for context on what was done, decisions made, and current state.');
    if (input.targetHasMcpAccess) {
      lines.push('You can also use the `kangentic_get_session_history` MCP tool to read the prior session content directly.');
    }
  } else {
    lines.push('No session history file is available. Check `git log` for prior changes on this branch.');
  }
  lines.push('');
  lines.push('<handoff_context>');
  lines.push(`  <source_agent>${escapeXml(input.sourceDisplayName)}</source_agent>`);
  if (input.sessionFilePath) {
    lines.push(`  <session_history_path>${escapeXml(input.sessionFilePath)}</session_history_path>`);
  } else {
    lines.push('  <session_history_path />');
  }
  lines.push('</handoff_context>');
  return lines.join('\n');
}
