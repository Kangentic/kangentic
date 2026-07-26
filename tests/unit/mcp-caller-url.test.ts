/**
 * Unit tests for `appendCallerSession` (src/main/agent/mcp-http/caller-url.ts).
 *
 * The function is a single string-concatenation guard: it stamps a spawning
 * session's own id onto its project-scoped MCP URL so the server can identify
 * WHICH session is calling (see the file's own doc comment for the full
 * rationale). It had zero test coverage before this file - both spawn
 * chokepoints (prepare-spawn.ts, transition-engine.ts) call it, but neither of
 * their existing test suites ever passed a real project URL through, so
 * reverting this function to a no-op (`return projectUrl;`) would fail nothing
 * anywhere in the suite until now.
 */
import { describe, it, expect } from 'vitest';
import { appendCallerSession } from '../../src/main/agent/mcp-http/caller-url';

describe('appendCallerSession', () => {
  it('appends the caller session id as a third URL segment', () => {
    // Red: reverting to `return projectUrl;` (dropping the session segment)
    // makes this equal 'http://127.0.0.1:1234/mcp/proj-1', not the URL below.
    expect(appendCallerSession('http://127.0.0.1:1234/mcp/proj-1', 'session-abc')).toBe(
      'http://127.0.0.1:1234/mcp/proj-1/session-abc',
    );
  });

  it('returns undefined when projectUrl is undefined', () => {
    // The MCP server may not be enabled or not yet listening - callers rely on
    // this passing straight through so a spawn can omit --mcp-config entirely.
    expect(appendCallerSession(undefined, 'session-abc')).toBeUndefined();
  });

  it('returns undefined when projectUrl is an empty string', () => {
    expect(appendCallerSession('', 'session-abc')).toBeUndefined();
  });

  it('does not append anything for an empty caller session id (still concatenates the segment)', () => {
    // Not a realistic caller (every spawn chokepoint passes a real UUID), but
    // pins the function's actual contract: it does not validate the id, only
    // concatenates it - a trailing slash with nothing after it.
    expect(appendCallerSession('http://127.0.0.1:1234/mcp/proj-1', '')).toBe(
      'http://127.0.0.1:1234/mcp/proj-1/',
    );
  });

  it('preserves a project URL that itself has no port or extra path segments', () => {
    expect(appendCallerSession('http://127.0.0.1/mcp/proj-1', 'session-xyz')).toBe(
      'http://127.0.0.1/mcp/proj-1/session-xyz',
    );
  });
});
