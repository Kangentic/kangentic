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
export const PROJECT_SELECTOR_DESCRIPTION =
  'Optional project selector. Pass a project name (case-insensitive exact) or project UUID to route this call to a different project than the one the MCP client is bound to. If the user\'s request names another Kangentic project (e.g. "create a task in X to ..." or "move task #7 in X to Done"), pass that name here instead of omitting - do not rely on the active default when the prompt specifies a different target. Use kangentic_list_projects to discover valid selectors. Omit to target the active project.';

/**
 * Atomic create_task rate-limit counter shared across all requests served
 * by one server-launch. Encapsulated as a getter+mutator pair so the
 * check-and-increment is impossible to race in the JS event loop.
 */
export interface TaskCounter {
  /** Reserve one slot. Returns false if the rate-limit ceiling is reached. */
  tryReserve(): boolean;
}

/** Build an in-memory TaskCounter enforcing a per-launch ceiling. */
export function makeTaskCounter(max: number): TaskCounter {
  let count = 0;
  return {
    tryReserve: () => {
      if (count >= max) return false;
      count++;
      return true;
    },
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
 */
export async function withProject(
  resolver: RequestResolver,
  selector: string | null | undefined,
  run: (context: CommandContext, resolved: ResolvedProject) => Promise<McpToolResult>,
): Promise<McpToolResult> {
  const resolved = resolver.resolveProject(selector);
  if ('error' in resolved) {
    return {
      content: [{ type: 'text' as const, text: resolved.error }],
      isError: true,
    };
  }
  const result = await run(resolved.context, resolved);
  if (resolved.isDefault) {
    return result;
  }
  return annotateWithProject(result, resolved);
}

/**
 * Prepend a `[Project: <name> (<shortId>)]` line to the first text
 * content block. Keeps downstream parsers (which already look at the
 * first line of handler output) working since the annotation is
 * visually obvious but doesn't change the shape of `data` or `message`
 * when the handler returned structured data.
 */
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
