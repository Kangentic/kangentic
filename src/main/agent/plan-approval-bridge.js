#!/usr/bin/env node
/**
 * Plan Approval Bridge - answers an agent CLI's plan approval prompt, and
 * nothing else, when Kangentic's decision for the session says to.
 *
 * An adapter that declares `supportsPlanAutoApproval` registers this script as
 * a hook on its plan approval prompt, on every spawn, whatever the column's
 * setting. The decision file decides at run time, so a column or workflow
 * switched to Automatic (or back to Manual) while the agent plans is honored
 * without the hooks reloading.
 *
 * Usage:
 *   node plan-approval-bridge.js <decision-path> <events-path> <spec>
 *
 * <decision-path>  `<session dir>/plan-approval.json`, written by main
 *                  (`src/main/plan-approval/plan-approval-writer.ts`):
 *                  { approve: boolean, mode: string, detail: string | null }
 * <events-path>    the session's events.jsonl. An approval appends one
 *                  `plan_approval_sent` line, which tells the activity
 *                  pipeline to drop the permission idle the same prompt raised.
 * <spec>           base64(JSON) from `buildPlanApprovalCommand`
 *                  (`src/main/agent/shared/plan-approval-hook.ts`). All agent
 *                  knowledge travels here, never in this file:
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
 *
 * Fails closed: a stdin that is not this tool, a missing or unreadable
 * decision, `approve: false`, or any error prints NOTHING and exits 0, so the
 * CLI shows its own approval dialog and the user decides. Diagnostics go to
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
    if (!context || context[spec.toolField] !== spec.tool) return;

    let decision;
    try {
      decision = readJson(decisionPath);
    } catch {
      // No decision yet (a session spawned before this build, or main has not
      // written one): the user approves, as they always did.
      return;
    }
    if (!decision || decision.approve !== true || typeof decision.mode !== 'string') return;

    const toolInput = context[spec.inputField];
    if (toolInput === undefined) {
      logError(`stdin has no ${spec.inputField}`);
      return;
    }
    const mode = spec.modes && typeof spec.modes[decision.mode] === 'string' ? spec.modes[decision.mode] : decision.mode;
    const reply = JSON.stringify(fill(spec.reply, toolInput, mode));

    // The marker first: if it cannot be written the pipeline would show the
    // prompt as "needs you" for a plan that was approved, so approve only when
    // it lands.
    if (eventsPath) {
      const marker = { ts: Date.now(), type: 'plan_approval_sent' };
      if (typeof decision.detail === 'string') marker.detail = decision.detail.slice(0, 200);
      fs.appendFileSync(eventsPath, JSON.stringify(marker) + '\n');
    }
    process.stdout.write(reply);
  } catch (error) {
    logError(error && error.message ? error.message : String(error));
  }
});
