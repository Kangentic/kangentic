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
 *                    reply: object        printed to approve, as it is
 *                  }
 *
 * Fails closed: a stdin that is not a tool the spec names, a missing or
 * unreadable decision, `approve: false`, or any error prints NOTHING and exits
 * 0, so the CLI shows its own dialog and the user decides. Diagnostics go to
 * the sibling `plan-approval-bridge.error.log`, never to stdout, which the CLI
 * parses as the hook's answer.
 */

const fs = require('fs');
const path = require('path');

const [, , decisionPath, eventsPath, encodedSpec] = process.argv;

function logError(message) {
  if (!decisionPath) return;
  try {
    const errorPath = path.join(path.dirname(decisionPath), 'plan-approval-bridge.error.log');
    fs.appendFileSync(errorPath, `${new Date().toISOString()} ${message}\n`);
  } catch {
    // Nothing more to do.
  }
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

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

/** The session's decision when it approves the plan, or null. */
function readApprovingDecision() {
  let decision;
  try {
    decision = readJson(decisionPath);
  } catch {
    // No decision yet (a session spawned before this build, or main has not
    // written one): the user approves, as they always did.
    return null;
  }
  return decision && decision.approve === true ? decision : null;
}

/**
 * Approve: the marker first, then the reply. If the marker cannot be written
 * the pipeline would show the prompt as "needs you" for a call the CLI runs,
 * so the throw reaches the caller's catch and nothing is printed.
 */
function sendApproval(marker, reply) {
  if (eventsPath) fs.appendFileSync(eventsPath, JSON.stringify(marker) + '\n');
  process.stdout.write(reply);
}

/** The tool spec carries `tools` and `prefixes`; the plan spec carries neither. */
function isToolSpec(spec) {
  return Array.isArray(spec.tools) || Array.isArray(spec.prefixes);
}

function stringList(value) {
  return Array.isArray(value) ? value.filter((entry) => typeof entry === 'string') : [];
}

/** Whether a tool spec answers this tool: named, and not excluded. */
function toolSpecNames(spec, tool) {
  if (typeof tool !== 'string') return false;
  if (stringList(spec.excludedTools).includes(tool)) return false;
  if (stringList(spec.excludedPrefixes).some((prefix) => tool.startsWith(prefix))) return false;
  return stringList(spec.tools).includes(tool) || stringList(spec.prefixes).some((prefix) => tool.startsWith(prefix));
}

/**
 * The tool spec: answer a prompt for a tool the spec names, in a mode it
 * names, while the decision approves the plan. The reply is printed as it is.
 */
function answerToolPrompt(spec, context) {
  const tool = context[spec.toolField];
  if (!toolSpecNames(spec, tool)) return;
  if (!stringList(spec.modes).includes(context[spec.modeField])) return;
  if (!readApprovingDecision()) return;
  sendApproval({ ts: Date.now(), type: 'tool_approval_sent', tool }, JSON.stringify(spec.reply));
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  try {
    if (!decisionPath || !encodedSpec) return;
    const spec = JSON.parse(Buffer.from(encodedSpec, 'base64').toString('utf8'));
    if (!spec || typeof spec !== 'object' || !spec.reply) {
      logError('malformed spec');
      return;
    }

    let context;
    try {
      context = JSON.parse(input);
    } catch {
      return;
    }
    if (!context || typeof context !== 'object') return;
    if (isToolSpec(spec)) {
      answerToolPrompt(spec, context);
      return;
    }
    if (context[spec.toolField] !== spec.tool) return;

    const decision = readApprovingDecision();
    if (!decision || typeof decision.mode !== 'string') return;

    const toolInput = context[spec.inputField];
    if (toolInput === undefined) {
      logError(`stdin has no ${spec.inputField}`);
      return;
    }
    const mode = spec.modes && typeof spec.modes[decision.mode] === 'string' ? spec.modes[decision.mode] : decision.mode;
    const reply = JSON.stringify(fill(spec.reply, toolInput, mode));

    const marker = { ts: Date.now(), type: 'plan_approval_sent' };
    if (typeof decision.detail === 'string') marker.detail = decision.detail.slice(0, 200);
    sendApproval(marker, reply);
  } catch (error) {
    logError(error && error.message ? error.message : String(error));
  }
});
