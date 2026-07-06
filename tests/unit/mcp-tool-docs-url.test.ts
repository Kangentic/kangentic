/**
 * Pins the literal MCP tool docs deep-link (see src/shared/mcp-tool-manifest.ts,
 * lines 109-115).
 *
 * The only other coverage is tests/ui/settings-panel.spec.ts, which asserts a
 * clicked pill opens `mcpToolDocsUrl('kangentic_create_task')` - but it computes
 * the expected value by calling mcpToolDocsUrl itself, so both sides of that
 * assertion move together. Reverting the anchor format (e.g. `?tool=` instead of
 * `#`) or pointing MCP_SERVER_DOCS_URL at the wrong base would not fail anything.
 *
 * This test pins the literal output instead, so a format or base-URL regression
 * goes red.
 */

import { describe, it, expect } from 'vitest';
import { MCP_SERVER_DOCS_URL, mcpToolDocsUrl, MCP_TOOL_MANIFEST } from '../../src/shared/mcp-tool-manifest';

describe('mcpToolDocsUrl', () => {
  it('pins the live docs base URL', () => {
    expect(MCP_SERVER_DOCS_URL).toBe('https://kangentic.com/mcp-server/');
  });

  it('pins the literal deep-link for a known tool name', () => {
    expect(mcpToolDocsUrl('kangentic_create_task')).toBe(
      'https://kangentic.com/mcp-server/#kangentic_create_task',
    );
  });

  it('derives every manifest entry link from the base URL and registered name, with no per-tool hardcoding', () => {
    for (const entry of MCP_TOOL_MANIFEST) {
      expect(mcpToolDocsUrl(entry.name)).toBe(`${MCP_SERVER_DOCS_URL}#${entry.name}`);
    }
  });
});
