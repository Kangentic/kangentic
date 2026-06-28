/**
 * MCP tool-list parity guard (see .claude/rules/mcp-tool-list-parity.md).
 *
 * The Kangentic MCP server registers its tools across the `*-tools.ts` files in
 * src/main/agent/mcp-http/. Two human-facing surfaces enumerate those tools:
 * the Settings -> MCP Server "Available Tools" list (McpServerTab.tsx) and
 * docs/mcp-server.md. Both used to hardcode their own copy and drifted - the
 * panel listed 10 of 46 registered tools, missing the whole browser and backlog
 * families.
 *
 * src/shared/mcp-tool-manifest.ts is now the one list both surfaces read. This
 * test (pure source analysis, runs in CI) makes drift unmergeable by asserting:
 *   (a) every registered tool has a manifest entry (a new tool fails until listed);
 *   (b) every manifest entry names a real registered tool (a renamed/removed
 *       tool fails until the manifest is updated);
 *   (c) every manifest tool is documented in docs/mcp-server.md, which is the
 *       exhaustive reference.
 *
 * The dev-only kangentic_devtools_* tools live under src/devtools/, OUTSIDE the
 * scanned glob, so they are intentionally not in scope. Within scope, every
 * registered tool is enumerated in the panel and the docs; the diagnostics group
 * (diagnostics + query_db) simply renders last under its own header.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { MCP_TOOL_MANIFEST } from '../../src/shared/mcp-tool-manifest';

const REPO_ROOT = path.resolve(__dirname, '../..');
const MCP_HTTP_DIR = path.join(REPO_ROOT, 'src/main/agent/mcp-http');
const DOCS_PATH = path.join(REPO_ROOT, 'docs/mcp-server.md');

/** The shipped registration files. Glob by suffix so a brand-new `<x>-tools.ts` is auto-covered. */
function collectToolFiles(): string[] {
  return fs
    .readdirSync(MCP_HTTP_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('-tools.ts'))
    .map((entry) => path.join(MCP_HTTP_DIR, entry.name));
}

/**
 * Collect every registerTool('<name>', ...) literal. The name literal sits on
 * the line AFTER `registerTool(`, so we scan whole-file content (JS `\s`
 * matches the newline) rather than line-by-line.
 */
function collectRegisteredToolNames(): Set<string> {
  const names = new Set<string>();
  const pattern = /registerTool\(\s*(['"])([^'"]+)\1/g;
  for (const filePath of collectToolFiles()) {
    const content = fs.readFileSync(filePath, 'utf-8');
    for (const match of content.matchAll(pattern)) {
      names.add(match[2]);
    }
  }
  return names;
}

const registeredNames = collectRegisteredToolNames();
const manifestNames = new Set(MCP_TOOL_MANIFEST.map((entry) => entry.name));

describe('mcp tool-list parity', () => {
  it('finds the registered tools (glob did not silently miss the files)', () => {
    expect(registeredNames.size).toBeGreaterThan(0);
  });

  it('the manifest has no duplicate tool names', () => {
    expect(manifestNames.size).toBe(MCP_TOOL_MANIFEST.length);
  });

  it('every registered tool has a manifest entry', () => {
    const missing = [...registeredNames].filter((name) => !manifestNames.has(name)).sort();
    expect(
      missing,
      `These tools are registered under src/main/agent/mcp-http/*-tools.ts but missing from `
        + `MCP_TOOL_MANIFEST (src/shared/mcp-tool-manifest.ts). Add an entry with a label, blurb, `
        + `and category:\n${missing.join('\n')}`,
    ).toEqual([]);
  });

  it('every manifest entry names a real registered tool', () => {
    const phantom = [...manifestNames].filter((name) => !registeredNames.has(name)).sort();
    expect(
      phantom,
      `These MCP_TOOL_MANIFEST entries name no registered tool (renamed or removed?). Remove or `
        + `fix them in src/shared/mcp-tool-manifest.ts:\n${phantom.join('\n')}`,
    ).toEqual([]);
  });

  it('every manifest tool is documented in docs/mcp-server.md', () => {
    const docContent = fs.readFileSync(DOCS_PATH, 'utf-8');
    const undocumented = MCP_TOOL_MANIFEST.map((entry) => entry.name)
      .filter((name) => !docContent.includes(name))
      .sort();
    expect(
      undocumented,
      `These tools are not documented in docs/mcp-server.md (the exhaustive reference). Add a `
        + `description for each:\n${undocumented.join('\n')}`,
    ).toEqual([]);
  });
});
