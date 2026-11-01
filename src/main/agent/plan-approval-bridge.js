#!/usr/bin/env node
/**
 * Plan Approval Bridge - answers an agent CLI's plan approval prompt when
 * Kangentic's decision for the session says to, and, while it does, a
 * permission prompt for a tool the project allows that the CLI's plan mode
 * asks about anyway. Nothing else.
 *
 * An adapter that declares `supportsPlanAutoApproval` registers this script as
 * a hook on its plan approval prompt, on every spawn, whatever the column's
 * setting. The decision file decides at run time, so a column or workflow
 * switched to Automatic (or back to Manual) while the agent plans is honored
 * without the hooks reloading. An adapter may register it a second time, with a
 * tool spec, on its tool permission prompts (`mayApprovePlanTool`, task #870).
 *
 * Usage:
 *   node plan-approval-bridge.js <decision-path> <events-path> <spec>
 *
 * <decision-path>  `<session dir>/plan-approval.json`, written by main
 *                  (`src/main/plan-approval/plan-approval-writer.ts`):
 *                  { approve: boolean, mode: string, detail: string | null }
 * <events-path>    the session's events.jsonl. An approval appends one marker
 *                  line, `plan_approval_sent` or `tool_approval_sent`, which
 *                  tells the activity pipeline to drop the permission idle the
 *                  same prompt raised.
 * <spec>           base64(JSON) from `buildPlanApprovalCommand`
 *                  (`src/main/agent/shared/plan-approval-hook.ts`). All agent
 *                  knowledge travels here, never in this file. The plan spec:
 *                  {
 *                    toolField: string,   stdin field holding the tool name
 *                    tool: string,        the plan exit tool's name
 *                    inputField: string,  stdin field holding the tool input
 *                    reply: object,       printed to approve. A string value
 *                                         "{{toolInput}}" becomes the tool
 *                                         input exactly as received, and
 *                                         "{{mode}}" the decision's mode.
 *                    modes?: object       Kangentic mode -> the CLI's name
 *                  }
 *                  The tool spec, told apart by its `tools` and `prefixes`:
 *                  {
 *                    toolField: string,   stdin field holding the tool name
 *                    modeField: string,   stdin field holding the session's mode
 *                    modes: string[],     the modes it answers in
 *                    tools: string[],     tools answered by exact name
 *                    prefixes: string[],  tools answered by name prefix
 *                    excludedTools: string[], excludedPrefixes: string[],
 *                                         never answered, whatever the above say
 *                    inputJudgedTools?: [{ tool, inputField, actionField, allow[], whenMissing }],
 *                                         a tool answered with no allow rule when
 *                                         input[actionField] (or whenMissing, absent) is
 *                                         one of allow: a call that only reads or
 *                                         publishes, never one that edits or deletes
 *                    reply: object        printed to approve, as it is
 *                  }
 *
 * Fails closed: a stdin that is not a tool the spec names, a missing or
 * unreadable decision, `approve: false`, or any error prints NOTHING and exits
 * 0, so the CLI shows its own dialog and the user decides. Diagnostics go to
 * the sibling `plan-approval-bridge.error.log`, never to stdout, which the CLI
 * parses as the hook's answer.
 *
 * Main also loads this file, for a CLI installed in a WSL distro: there the
 * hook publishes its request to a file (`wsl-hook-transport.ts`) and Kangentic
 * answers it with `planApprovalAnswer`. Loading it has no side effect.
 */

const fs = require('fs');
const path = require('path');

/** Copy the reply template, putting the tool input and the mode in place. */
function fill(template, toolInput, mode) {
  if (template === '{{toolInput}}') return toolInput;
  if (template === '{{mode}}') return mode;
  if (Array.isArray(template)) return template.map((entry) => fill(entry, toolInput, mode));
  if (template && typeof template === 'object') {
    const filled = {};
    for (const [key, value] of Object.entries(template)) filled[key] = fill(value, toolInput, mode);
    return filled;
  }
  return template;
}

/** The decision when it approves the plan, or null. */
function approvingDecision(decision) {
  return decision && decision.approve === true ? decision : null;
}

/** The tool spec carries `tools` and `prefixes` (or input-judged tools); the plan spec carries none. */
function isToolSpec(spec) {
  return Array.isArray(spec.tools) || Array.isArray(spec.prefixes) || Array.isArray(spec.inputJudgedTools);
}

function stringList(value) {
  return Array.isArray(value) ? value.filter((entry) => typeof entry === 'string') : [];
}

/** Whether a tool spec excludes this tool, whatever else it says. */
function toolSpecExcludes(spec, tool) {
  return stringList(spec.excludedTools).includes(tool)
    || stringList(spec.excludedPrefixes).some((prefix) => tool.startsWith(prefix));
}

/**
 * Whether a call to one of the spec's input-judged tools only does what the
 * spec allows: the value of its input field (or, absent, what the tool does
 * by default) is one of `allow`. A call with any other value, or an input
 * that is not an object, is left to the user.
 */
function inputJudgedCallAllowed(spec, context, tool) {
  const entries = Array.isArray(spec.inputJudgedTools) ? spec.inputJudgedTools : [];
  const entry = entries.find((candidate) => candidate && candidate.tool === tool);
  if (!entry) return false;
  const input = context[entry.inputField];
  if (!input || typeof input !== 'object') return false;
  const value = input[entry.actionField];
  const action = value === undefined || value === null ? entry.whenMissing : value;
  return typeof action === 'string' && stringList(entry.allow).includes(action);
}

/** Whether a tool spec answers this call: named or judged allowed by its input, and not excluded. */
function toolSpecAnswers(spec, context, tool) {
  if (typeof tool !== 'string') return false;
  if (toolSpecExcludes(spec, tool)) return false;
  if (stringList(spec.tools).includes(tool) || stringList(spec.prefixes).some((prefix) => tool.startsWith(prefix))) return true;
  return inputJudgedCallAllowed(spec, context, tool);
}

/**
 * The tool spec: answer a prompt for a call the spec answers, in a mode it
 * names, while the decision approves the plan. The reply is printed as it is.
 */
function answerToolPrompt(spec, context, readDecision, now) {
  const tool = context[spec.toolField];
  if (!toolSpecAnswers(spec, context, tool)) return null;
  if (!stringList(spec.modes).includes(context[spec.modeField])) return null;
  if (!approvingDecision(readDecision())) return null;
  return { marker: { ts: now, type: 'tool_approval_sent', tool }, reply: JSON.stringify(spec.reply) };
}

/**
 * What to answer one prompt with, or null to leave it to the user. Approving
 * means writing `marker` to the events file and only then printing `reply`: a
 * marker that cannot be written must leave the prompt unanswered, or the
 * pipeline would show "needs you" for a call the CLI runs.
 *
 * `readDecision` returns the parsed decision file, or null when there is none
 * (a session spawned before this build, or main has not written one: the user
 * approves, as they always did). It is called only for a prompt the spec names.
 * Throws on a malformed spec or a tool input that is missing; the caller logs it.
 *
 * @param {{ encodedSpec: string, input: string, readDecision: () => unknown, now: number }} options
 * @returns {{ marker: object, reply: string } | null}
 */
function planApprovalAnswer(options) {
  const { encodedSpec, input, readDecision, now } = options;
  if (!encodedSpec) return null;
  const spec = JSON.parse(Buffer.from(encodedSpec, 'base64').toString('utf8'));
  if (!spec || typeof spec !== 'object' || !spec.reply) throw new Error('malformed spec');

  let context;
  try {
    context = JSON.parse(input);
  } catch {
    return null;
  }
  if (!context || typeof context !== 'object') return null;
  if (isToolSpec(spec)) return answerToolPrompt(spec, context, readDecision, now);
  if (context[spec.toolField] !== spec.tool) return null;

  const decision = approvingDecision(readDecision());
  if (!decision || typeof decision.mode !== 'string') return null;

  const toolInput = context[spec.inputField];
  if (toolInput === undefined) throw new Error(`stdin has no ${spec.inputField}`);
  const mode = spec.modes && typeof spec.modes[decision.mode] === 'string' ? spec.modes[decision.mode] : decision.mode;
  const reply = JSON.stringify(fill(spec.reply, toolInput, mode));

  const marker = { ts: now, type: 'plan_approval_sent' };
  if (typeof decision.detail === 'string') marker.detail = decision.detail.slice(0, 200);
  return { marker, reply };
}

module.exports = { planApprovalAnswer };

if (require.main === module) {
  const [, , decisionPath, eventsPath, encodedSpec] = process.argv;

  const logError = (message) => {
    if (!decisionPath) return;
    try {
      const errorPath = path.join(path.dirname(decisionPath), 'plan-approval-bridge.error.log');
      fs.appendFileSync(errorPath, `${new Date().toISOString()} ${message}\n`);
    } catch {
      // Nothing more to do.
    }
  };

  const readDecision = () => {
    try {
      return JSON.parse(fs.readFileSync(decisionPath, 'utf8'));
    } catch {
      return null;
    }
  };

  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { input += chunk; });
  process.stdin.on('end', () => {
    try {
      if (!decisionPath || !encodedSpec) return;
      const answer = planApprovalAnswer({ encodedSpec, input, readDecision, now: Date.now() });
      if (!answer) return;
      // The marker first, then the reply. A marker that cannot be written
      // throws into the catch below, and nothing is printed.
      if (eventsPath) fs.appendFileSync(eventsPath, JSON.stringify(answer.marker) + '\n');
      process.stdout.write(answer.reply);
    } catch (error) {
      logError(error && error.message ? error.message : String(error));
    }
  });
}
