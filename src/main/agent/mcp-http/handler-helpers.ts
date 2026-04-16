import { commandHandlers } from '../commands';
import type { CommandContext, CommandResponse } from '../commands';

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
) {
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
