import { commandHandlers } from '../commands';
import type { CommandContext, CommandResponse } from '../commands';
import type { RequestResolver, ResolvedProject } from './project-resolver';

/**
 * Shape of an MCP tool result: JSON-serialisable content blocks plus an
 * optional error flag. The SDK's own tool-result type has an
 * `[x: string]: unknown` index signature, so we mirror that here to
 * stay structurally compatible with `server.registerTool` return
 * signatures.
 */
export interface McpToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
  [key: string]: unknown;
}

/**
 * Shared description for the `project` argument that every
 * cross-project-aware MCP tool accepts. Lives here so task-tools and
 * session-tools import one source of truth.
 */
// Kept deliberately concise: the full cross-project routing rule (including
// how project mentions are phrased) lives once in the server `instructions`
// string (server-instructions.ts, "PROJECT ROUTING RULE"), which is in every
// agent's system prompt, and create_task carries its own routing guidance plus
// a runtime guardrail. Repeating the full paragraph on all ~28 project-aware
// tools added ~4.5k tokens of duplicated context to every spawned agent; this
// pointer keeps the behavioral trigger while shedding the duplication.
export const PROJECT_SELECTOR_DESCRIPTION =
  'Optional project name (case-insensitive exact) or UUID to target a different project than the active one. Set it whenever the user\'s request names another registered project; omit for the active project. See the server instructions ("PROJECT ROUTING RULE") for how mentions are phrased, and kangentic_list_projects for valid names.';

/**
 * Atomic create_task rate-limit counter shared across all requests served
 * by one server-launch. Encapsulated as a getter+mutator pair so the
 * check-and-increment is impossible to race in the JS event loop.
 */
export interface TaskCounter {
  /** Reserve one slot. Returns false if the rate-limit ceiling is reached. */
  tryReserve(): boolean;
  /** Current configured ceiling, read live. Used to build the rate-limit error message. */
  limit(): number;
}

/**
 * Build an in-memory TaskCounter enforcing a per-launch ceiling. The ceiling
 * is read live through `getMaxTaskCreateCount` on every reservation, so a
 * settings change to the cap takes effect without restarting the app (the
 * accumulated count still persists for the app launch and resets on restart).
 */
export function makeTaskCounter(getMaxTaskCreateCount: () => number): TaskCounter {
  let count = 0;
  return {
    tryReserve: () => {
      if (count >= getMaxTaskCreateCount()) return false;
      count++;
      return true;
    },
    limit: () => getMaxTaskCreateCount(),
  };
}

/**
 * Invoke a `commandHandlers` entry (which may be sync or async) and
 * return the raw CommandResponse, converting any thrown error into a
 * failure response. Tools that need to apply custom result formatting
 * use this directly instead of `callHandler`.
 */
export async function runHandler(
  handlerName: keyof typeof commandHandlers,
  params: Record<string, unknown>,
  context: CommandContext,
): Promise<CommandResponse> {
  try {
    const handler = commandHandlers[handlerName];
    if (!handler) {
      return { success: false, error: `Unknown command: ${String(handlerName)}` };
    }
    return await Promise.resolve(handler(params, context));
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return { success: false, error: errorMessage };
  }
}

/**
 * Run a handler and wrap its result as a default-shaped MCP tool result
 * (single text content block, optional `isError` flag on failure).
 * Tools that need richer formatting (structured data, multi-block
 * content) use `runHandler` directly.
 */
export async function callHandler(
  handlerName: keyof typeof commandHandlers,
  params: Record<string, unknown>,
  context: CommandContext,
  fallbackText: string,
): Promise<McpToolResult> {
  const response = await runHandler(handlerName, params, context);
  if (!response.success) {
    return {
      content: [{ type: 'text' as const, text: response.error ?? fallbackText }],
      isError: true,
    };
  }
  return {
    content: [{ type: 'text' as const, text: response.message ?? JSON.stringify(response.data ?? {}) }],
  };
}

/**
 * Resolve the optional cross-project `project` selector then run the
 * tool body against the resulting context. On resolution failure we
 * return an `isError` MCP result directly so callers don't need to
 * special-case this path. On success we prepend a single
 * `[Project: <name> (<shortId>)]` line to the first text block
 * whenever the caller explicitly crossed projects; omitting the
 * selector produces output byte-identical to today.
 *
 * Pass `{ alwaysAnnotate: true }` to also prefix the default-project
 * path so the resolved target is visible even when no selector was
 * given. create_task uses this so a silent default-to-active create is
 * loud at creation time instead of only catchable after the fact.
 */
export async function withProject(
  resolver: RequestResolver,
  selector: string | null | undefined,
  run: (context: CommandContext, resolved: ResolvedProject) => Promise<McpToolResult>,
  options?: { alwaysAnnotate?: boolean },
): Promise<McpToolResult> {
  const resolved = resolver.resolveProject(selector);
  if ('error' in resolved) {
    return {
      content: [{ type: 'text' as const, text: resolved.error }],
      isError: true,
    };
  }
  const result = await run(resolved.context, resolved);
  if (resolved.isDefault && !options?.alwaysAnnotate) {
    return result;
  }
  return annotateWithProject(result, resolved);
}

/**
 * Strip characters that would corrupt a single-line embedding of the
 * project name (newlines, brackets) and cap length so a pathologically
 * long project name can't swamp the tool response or instructions
 * string. Project names are user-controlled at project creation time,
 * so while the realistic blast radius is tiny, this keeps downstream
 * line-based parsing robust.
 *
 * Exported so server-instructions.ts can reuse the same normalisation
 * when embedding names in the top-level MCP `instructions` string.
 */
export function sanitizeProjectName(name: string): string {
  const stripped = name.replace(/[\r\n\]]/g, ' ');
  return stripped.length > 60 ? `${stripped.slice(0, 57)}...` : stripped;
}

/**
 * Project names shorter than this are skipped by the cross-project
 * mention scan. A one or two character name (e.g. "QA") is too likely
 * to collide with ordinary prose and trip the routing guardrail on a
 * task that has nothing to do with that project.
 */
const MIN_PROJECT_NAME_MATCH_LENGTH = 3;

/**
 * Build a case-insensitive regex that matches `name` as a whole token,
 * not as a substring. Boundaries are lookarounds on `[a-z0-9]` rather
 * than `\b` so that hyphenated and dotted names count as single tokens:
 * "kangentic" does not match inside "kangentics", and a bare
 * "kangentic" does not match "kangentic.com" (the trailing ".com"
 * differs). Multi-word names match the exact phrase because the internal
 * space is matched literally. Regex metacharacters in the name are
 * escaped so a literal dot in "kangentic.com" is not treated as a
 * wildcard.
 */
function buildWholePhraseRegex(name: string): RegExp {
  const escaped = name
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`, 'i');
}

/**
 * Return the names of registered projects, other than the active one,
 * whose name appears as a whole token in `haystack` (a task's title plus
 * description). Used by the create_task routing guardrail to catch a
 * silent default-to-active create whose text actually names a different
 * project. Returns a de-duplicated list in registration order.
 *
 * This only catches the subset where the other project's name leaks into
 * the task content. The primary defense against misrouting is the
 * server `instructions` and the `project` selector guidance, which the
 * agent reads against the full user prompt.
 */
export function detectCrossProjectMention(resolver: RequestResolver, haystack: string): string[] {
  const text = haystack.toLowerCase().replace(/\s+/g, ' ');
  const hits: string[] = [];
  for (const project of resolver.listProjects()) {
    if (project.isActive) continue;
    const name = project.name.trim();
    if (name.length < MIN_PROJECT_NAME_MATCH_LENGTH) continue;
    // Push the trimmed `name` (what the regex matched on), not the raw
    // `project.name`, so a whitespace-padded DB name is reported and
    // embedded consistently with what was actually matched.
    if (buildWholePhraseRegex(name).test(text)) hits.push(name);
  }
  return [...new Set(hits)];
}

/**
 * Prepend a `[Project: <name> (<shortId>)]` line to the first text
 * content block. Keeps downstream parsers (which already look at the
 * first line of handler output) working since the annotation is
 * visually obvious but doesn't change the shape of `data` or `message`
 * when the handler returned structured data.
 */
function annotateWithProject(result: McpToolResult, resolved: ResolvedProject): McpToolResult {
  const shortId = resolved.projectId.slice(0, 8);
  const safeName = sanitizeProjectName(resolved.projectName);
  const prefix = `[Project: ${safeName} (${shortId})]`;
  const firstBlock = result.content[0];
  if (!firstBlock || firstBlock.type !== 'text') {
    return {
      ...result,
      content: [{ type: 'text' as const, text: prefix }, ...result.content],
    };
  }
  return {
    ...result,
    content: [
      { type: 'text' as const, text: `${prefix}\n${firstBlock.text}` },
      ...result.content.slice(1),
    ],
  };
}
