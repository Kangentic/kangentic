/**
 * Type guard for AbortError thrown by AbortSignal.throwIfAborted().
 * Use in catch blocks to re-throw abort errors while handling other errors:
 *
 *   catch (error) {
 *     if (isAbortError(error)) throw error;
 *     console.error('Non-abort error:', error);
 *   }
 */
export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}
