import path from 'node:path';
import type { PermissionMode } from '../../../shared/types';
import { encodeHookSpec, quoteBridgePath, type HookShell } from './hook-utils';

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

/**
 * The same bridge, registered on a second prompt: a tool the project allows,
 * which the CLI's plan mode asks about anyway (an MCP tool with no read-only
 * annotation, for Claude). The bridge answers it only while the decision file
 * approves the plan, so it covers exactly the sessions nobody watches.
 *
 * The bridge tells the two specs apart by `tools`/`prefixes`, which only this
 * one carries.
 */
export interface PlanToolApprovalHookSpec {
  /** The stdin field naming the tool the prompt is for. */
  toolField: string;
  /** The stdin field holding the session's permission mode. */
  modeField: string;
  /** The modes the bridge answers in, in the CLI's own words. Any other mode is left alone. */
  modes: string[];
  /** Tools answered by exact name. */
  tools: string[];
  /** Tools answered when their name starts with one of these. */
  prefixes: string[];
  /** Tools never answered, by exact name, whatever `tools` and `prefixes` say. */
  excludedTools: string[];
  /** Tools never answered when their name starts with one of these. */
  excludedPrefixes: string[];
  /**
   * Calls answered by what their input asks, with no allow rule: a CLI's own
   * tool whose call only reads or publishes for one value of an input field
   * and edits or deletes for another. An excluded tool is never answered.
   */
  inputJudgedTools?: PlanToolInputJudgedCall[];
  /** What the hook prints to approve. No placeholders: the tool's input is not echoed. */
  reply: PlanApprovalReplyValue;
}

/** One tool the bridge answers by its input (`PlanToolApprovalHookSpec.inputJudgedTools`). */
export interface PlanToolInputJudgedCall {
  /** The tool's name, exactly. */
  tool: string;
  /** The stdin field holding the tool's input object. */
  inputField: string;
  /** The field inside that input object that says what the call does (`Artifact`'s `action`). */
  actionField: string;
  /** The values of `actionField` the bridge answers. Anything else is left to the user. */
  allow: string[];
  /** What the call does when `actionField` is absent, as the tool documents it, or null to leave such a call alone. */
  whenMissing: string | null;
}

/**
 * Build the hook command: `node "<bridge>" "<decision>" "<events>" <base64 spec>`,
 * each path quoted for the adapter's declared `windowsShell`.
 */
export function buildPlanApprovalCommand(
  windowsShell: HookShell,
  bridgePath: string,
  decisionPath: string,
  eventsPath: string,
  spec: PlanApprovalHookSpec | PlanToolApprovalHookSpec,
): string {
  const quote = (filePath: string): string => quoteBridgePath(filePath, windowsShell);
  return `node ${quote(bridgePath)} ${quote(decisionPath)} ${quote(eventsPath)} ${encodeHookSpec(spec)}`;
}
