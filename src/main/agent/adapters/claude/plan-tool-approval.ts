import type { PlanToolApprovalHookSpec } from '../../shared/plan-approval-hook';

/**
 * Which MCP tools Kangentic's plan approval hook answers for a Claude session
 * while its plan is approved automatically (task #870).
 *
 * Claude's plan mode prompts for every tool that is not read-only, and an MCP
 * tool whose server does not annotate it `readOnlyHint` is not. An allow rule
 * does not reach past that gate (`src/main/agent/mcp-http/annotations.ts`). A
 * Planning column that approves its plans automatically runs unattended, so a
 * call to such a tool stopped a workflow task at "Do you want to proceed?"
 * until someone answered it, even though the project allowed the tool. The
 * plan approval bridge answers that prompt instead, for a tool the user's own
 * allow rules name, while the session's decision file approves its plan.
 *
 * Measured on Claude Code 2.1.306, Windows, `claude -p` and the interactive TUI
 * (`scripts/probe-claude-plan-tool-approval.js`):
 * - an allow rule alone: `-p` denied the call ("Cannot call ... while in plan
 *   mode"), and the TUI left its dialog open;
 * - a PermissionRequest hook printing allow: the call ran in both, a
 *   subagent's included, with no dialog left open;
 * - every request carried `permission_mode` "plan", a subagent's too;
 * - an ask rule plus the hook's allow: the call ran. A hook's allow outranks
 *   an ask rule, so an ask or deny rule for a tool is honored here, by leaving
 *   that tool out, not by Claude.
 *
 * The rules come from the permission lists Kangentic merges into the session's
 * settings (the project's `.claude/settings.json` and `settings.local.json`,
 * the worktree's `settings.local.json`) and the user's `~/.claude/settings.json`,
 * all of which Claude applies to the session. Managed settings are not read. An
 * organization that sets `allowManagedPermissionRulesOnly` could see a tool run
 * that only a project rule allows, and a managed ask rule for a tool a project
 * or user rule allows is answered anyway, since the hook's allow outranks it.
 * That setup is rare, and the hook answers nothing outside an automatic plan
 * approval.
 *
 * Kangentic's own server is always left out. Kangentic adds `mcp__kangentic` to
 * every session's allow list, and its mutating tools must keep prompting while
 * planning (docs/integrations/mcp-server/how-it-works.md, "Honest mutating annotations"). Its read-only
 * tools already pass through their `readOnlyHint`.
 */

/** The `permissions` lists one settings file carries. Every other key is ignored. */
export interface ClaudePermissionLists {
  allow?: unknown;
  deny?: unknown;
  ask?: unknown;
}

/** The tools the hook may answer, and the ones it never does. */
export interface PlanToolApprovalRules {
  tools: string[];
  prefixes: string[];
  excludedTools: string[];
  excludedPrefixes: string[];
}

const MCP_TOOL_PREFIX = 'mcp__';
const KANGENTIC_TOOLS_PREFIX = 'mcp__kangentic__';

/**
 * The hook's matcher: every MCP tool. Claude reads a matcher with anything but
 * letters, digits and `|` as a regular expression. The bridge decides which of
 * them it answers.
 */
export const CLAUDE_PLAN_TOOL_APPROVAL_MATCHER = `${MCP_TOOL_PREFIX}.*`;

type McpRule = { kind: 'tool'; name: string } | { kind: 'prefix'; prefix: string };

/**
 * One permission rule read as Claude's MCP forms: `mcp__server` and
 * `mcp__server__*` cover the server's tools, `mcp__server__tool` one tool.
 * Anything else, a partial wildcard or a rule with a specifier included, is
 * not an MCP rule here, so it approves nothing.
 */
function parseMcpRule(rule: unknown): McpRule | null {
  if (typeof rule !== 'string' || !rule.startsWith(MCP_TOOL_PREFIX) || rule.includes('(')) return null;
  const rest = rule.slice(MCP_TOOL_PREFIX.length);
  const separator = rest.indexOf('__');
  if (separator < 0) {
    if (rest.length === 0 || rest.includes('*')) return null;
    return { kind: 'prefix', prefix: `${rule}__` };
  }
  const server = rest.slice(0, separator);
  const tool = rest.slice(separator + 2);
  if (server.length === 0 || server.includes('*') || tool.length === 0) return null;
  if (tool === '*') return { kind: 'prefix', prefix: `${MCP_TOOL_PREFIX}${server}__` };
  if (tool.includes('*')) return null;
  return { kind: 'tool', name: rule };
}

function rulesIn(list: unknown): McpRule[] {
  if (!Array.isArray(list)) return [];
  return list.flatMap((rule) => {
    const parsed = parseMcpRule(rule);
    return parsed ? [parsed] : [];
  });
}

/**
 * A deny or ask list read for what it keeps from the hook. A rule in one of
 * the MCP forms excludes what it names. Any other rule that starts with
 * `mcp__` (a partial wildcard such as `mcp__docs__get_*`, or a specifier)
 * excludes every tool its text up to the `*` or `(` begins, because the hook's
 * allow would outrank it. A rule read too widely costs a prompt, never a call
 * the user meant to see.
 */
function exclusionsIn(list: unknown): McpRule[] {
  if (!Array.isArray(list)) return [];
  return list.flatMap((rule): McpRule[] => {
    const parsed = parseMcpRule(rule);
    if (parsed) return [parsed];
    if (typeof rule !== 'string' || !rule.startsWith(MCP_TOOL_PREFIX)) return [];
    const literalEnd = rule.search(/[*(]/);
    return [{ kind: 'prefix', prefix: literalEnd < 0 ? rule : rule.slice(0, literalEnd) }];
  });
}

/**
 * The rules for one session, from every settings layer Claude applies to it,
 * or null when no allow rule names a tool the hook may answer.
 */
export function planToolApprovalRules(layers: Array<ClaudePermissionLists | undefined>): PlanToolApprovalRules | null {
  const tools = new Set<string>();
  const prefixes = new Set<string>();
  const excludedTools = new Set<string>();
  const excludedPrefixes = new Set<string>([KANGENTIC_TOOLS_PREFIX]);
  for (const layer of layers) {
    for (const rule of rulesIn(layer?.allow)) {
      if (rule.kind === 'tool') tools.add(rule.name);
      else prefixes.add(rule.prefix);
    }
    for (const rule of [...exclusionsIn(layer?.deny), ...exclusionsIn(layer?.ask)]) {
      if (rule.kind === 'tool') excludedTools.add(rule.name);
      else excludedPrefixes.add(rule.prefix);
    }
  }
  const excluded = (name: string): boolean =>
    excludedTools.has(name) || [...excludedPrefixes].some((prefix) => name.startsWith(prefix));
  // Pruned here only to decide whether the hook is registered at all. The
  // bridge checks the exclusions again on every prompt, so a prefix allowed
  // and kept still loses the tools an exclusion inside it names.
  for (const name of [...tools]) if (excluded(name)) tools.delete(name);
  for (const prefix of [...prefixes]) if (excluded(prefix)) prefixes.delete(prefix);
  if (tools.size === 0 && prefixes.size === 0) return null;
  return {
    tools: [...tools],
    prefixes: [...prefixes],
    excludedTools: [...excludedTools],
    excludedPrefixes: [...excludedPrefixes],
  };
}

/**
 * The bridge's spec for these rules: answer a PermissionRequest in plan mode
 * with a bare allow. Unlike the plan's reply it echoes no input: `updatedInput`
 * is needed only for a tool that collects an answer, which an MCP call does not.
 */
export function claudePlanToolApprovalSpec(rules: PlanToolApprovalRules): PlanToolApprovalHookSpec {
  return {
    toolField: 'tool_name',
    modeField: 'permission_mode',
    modes: ['plan'],
    ...rules,
    reply: { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } },
  };
}

/** Any MCP tool but Kangentic's own: the most any session's rules can name. */
export function mayApproveClaudePlanTool(toolName: string): boolean {
  return toolName.startsWith(MCP_TOOL_PREFIX) && !toolName.startsWith(KANGENTIC_TOOLS_PREFIX);
}
