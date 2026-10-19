import path from 'node:path';
import type { PermissionMode } from '../../../shared/types';
import { quoteBridgePath } from './hook-utils';

/**
 * The contract between main, which decides whether a session's next plan is
 * approved, and the plan approval hook an adapter registers on its CLI
 * (`src/main/agent/plan-approval-bridge.js`), which carries it out.
 *
 * Main writes the decision to a file in the session's own directory, so the
 * hook reads the CURRENT answer each time the prompt appears: a setting changed
 * while the agent plans needs no hook reload. Everything agent-specific (the
 * tool's name, where its input sits, the reply the CLI expects) is the adapter's
 * `PlanApprovalHookSpec`; the bridge and main know none of it.
 */

/** The decision file's name inside `.kangentic/sessions/<ptySessionId>/`. */
export const PLAN_APPROVAL_FILE_NAME = 'plan-approval.json';

export interface PlanApprovalDecision {
  /** Answer the plan approval prompt. False leaves it to the user. */
  approve: boolean;
  /** The mode the session continues in once the plan is approved, in Kangentic's vocabulary. */
  mode: PermissionMode;
  /** Where the task goes, for the activity log ("Moved to Executing"). */
  detail: string | null;
}

/** The decision file for a session directory. */
export function planApprovalDecisionPath(sessionDir: string): string {
  return path.join(sessionDir, PLAN_APPROVAL_FILE_NAME);
}

/** String values in `reply` the bridge replaces. */
export const PLAN_APPROVAL_TOOL_INPUT = '{{toolInput}}';
export const PLAN_APPROVAL_MODE = '{{mode}}';

/** A JSON value a reply template can hold. */
export type PlanApprovalReplyValue =
  | string
  | number
  | boolean
  | null
  | PlanApprovalReplyValue[]
  | { [key: string]: PlanApprovalReplyValue };

export interface PlanApprovalHookSpec {
  /** The stdin field naming the tool the prompt is for. */
  toolField: string;
  /** The CLI's plan exit tool. Any other tool is never answered. */
  tool: string;
  /** The stdin field holding the tool's input, echoed back exactly. */
  inputField: string;
  /** What the hook prints to approve, with `PLAN_APPROVAL_TOOL_INPUT` and `PLAN_APPROVAL_MODE` in place. */
  reply: PlanApprovalReplyValue;
  /** Kangentic mode -> the CLI's own name for it, where they differ. */
  modes?: Partial<Record<PermissionMode, string>>;
}

/** Build the hook command: `node "<bridge>" "<decision>" "<events>" <base64 spec>`. */
export function buildPlanApprovalCommand(
  bridgePath: string,
  decisionPath: string,
  eventsPath: string,
  spec: PlanApprovalHookSpec,
): string {
  // Base64 keeps the spec one shell token whatever it holds, as the event
  // bridge's directives do (directive-builders.ts).
  const encodedSpec = Buffer.from(JSON.stringify(spec), 'utf8').toString('base64');
  return `node ${quoteBridgePath(bridgePath)} ${quoteBridgePath(decisionPath)} ${quoteBridgePath(eventsPath)} ${encodedSpec}`;
}
