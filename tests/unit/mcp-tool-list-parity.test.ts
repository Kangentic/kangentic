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
import { READ_ONLY_ANNOTATIONS, MUTATING_ANNOTATIONS } from '../../src/main/agent/mcp-http/annotations';

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

const SHARED_ANNOTATION_TOKENS = ['READ_ONLY_ANNOTATIONS', 'MUTATING_ANNOTATIONS'] as const;
type SharedAnnotationToken = (typeof SHARED_ANNOTATION_TOKENS)[number];

interface ToolRegistration {
  name: string;
  file: string;
  /** Which shared annotation constant the registration declares, or null if none/inline. */
  annotation: SharedAnnotationToken | null;
}

/**
 * Slice every registerTool('<name>', ...) call into its own segment (from one
 * `registerTool(` to the next, or - for the last in a file - the enclosing
 * function's closing brace) and record which shared annotation
 * constant that segment declares. The name literal sits on the line AFTER
 * `registerTool(`, so we scan whole-file content (JS `\s` matches the newline)
 * rather than line-by-line. Attributing the annotation to a specific
 * registration (vs a per-file count) lets a failure name the offending tool
 * and requires the exact shared-constant tokens, which cannot plausibly appear
 * in prose.
 */
function collectToolRegistrations(): ToolRegistration[] {
  const registrations: ToolRegistration[] = [];
  const namePattern = /registerTool\(\s*(['"])([^'"]+)\1/g;
  const annotationPattern = /annotations:\s*(READ_ONLY_ANNOTATIONS|MUTATING_ANNOTATIONS)\b/;
  for (const filePath of collectToolFiles()) {
    const content = fs.readFileSync(filePath, 'utf-8');
    const fileName = path.basename(filePath);
    const matches = [...content.matchAll(namePattern)];
    for (let index = 0; index < matches.length; index += 1) {
      const start = matches[index].index ?? 0;
      // Bound the segment at the NEXT registerTool( call. For the last
      // registration in a file, bound at the enclosing register*Tools
      // function's closing brace (the first top-level `}`) rather than EOF, so
      // trailing top-level helper functions can never be scanned as part of
      // this tool's segment and false-match an `annotations:` token in their
      // code or prose - which would mask a deleted or flipped annotation on the
      // final tool.
      let end: number;
      if (index + 1 < matches.length) {
        end = matches[index + 1].index ?? content.length;
      } else {
        const functionCloseOffset = content.slice(start).search(/\n}/);
        end = functionCloseOffset === -1 ? content.length : start + functionCloseOffset;
      }
      const segment = content.slice(start, end);
      const annotationMatch = segment.match(annotationPattern);
      registrations.push({
        name: matches[index][2],
        file: fileName,
        annotation: annotationMatch ? (annotationMatch[1] as SharedAnnotationToken) : null,
      });
    }
  }
  return registrations;
}

/**
 * Tool-name prefixes that unambiguously denote a mutation - of the board, the
 * backlog, or (for `send`) a live agent session.
 *
 * `kangentic_send_` is here because a send writes into a running PTY, which is
 * at least as consequential as a board edit: annotated read-only it would be
 * silently auto-approved in plan mode, letting a plan-mode agent launder a side
 * effect through another agent that is not in plan mode. Keep this list ahead
 * of new write verbs (an `interrupt` tool would need `kangentic_interrupt_`).
 */
const MUTATING_NAME_PREFIXES = [
  'kangentic_create_',
  'kangentic_update_',
  'kangentic_delete_',
  'kangentic_remove_',
  'kangentic_move_',
  'kangentic_promote_',
  'kangentic_link_',
  'kangentic_send_',
];

const toolRegistrations = collectToolRegistrations();
const registeredNames = new Set(toolRegistrations.map((registration) => registration.name));
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

/**
 * Annotation parity guard (see .claude/rules/mcp-tool-list-parity.md).
 *
 * Every registered tool must declare `annotations:` using one of the two
 * shared constants in src/main/agent/mcp-http/annotations.ts. `readOnlyHint`
 * is load-bearing: Claude Code auto-approves read-only-annotated tools in plan
 * mode (no permission prompt), so a tool with no annotation prompts on every
 * call, and a mutation dishonestly marked read-only would be silently
 * auto-approved. These checks keep the classification present, honest, and
 * sourced from the single shared audit point.
 */
describe('mcp tool annotation parity', () => {
  it('every registered tool declares annotations via a shared constant', () => {
    const unannotated = toolRegistrations
      .filter((registration) => registration.annotation === null)
      .map((registration) => `${registration.file}: ${registration.name}`)
      .sort();
    expect(
      unannotated,
      `These tools are registered without \`annotations:\` referencing a shared constant. Add `
        + `\`annotations: READ_ONLY_ANNOTATIONS\` or \`annotations: MUTATING_ANNOTATIONS\` (imported `
        + `from src/main/agent/mcp-http/annotations.ts) to each registration. An unannotated tool `
        + `prompts for permission on every call in plan mode:\n${unannotated.join('\n')}`,
    ).toEqual([]);
  });

  it('the shared annotation constants carry the spec-correct values', () => {
    // Guards the hole the source regex cannot see: someone editing the
    // constant values in annotations.ts (e.g. flipping readOnlyHint).
    expect(READ_ONLY_ANNOTATIONS).toEqual({ readOnlyHint: true, idempotentHint: true });
    expect(MUTATING_ANNOTATIONS).toEqual({ readOnlyHint: false, idempotentHint: false });
  });

  it('no *-tools.ts file redefines the shared annotation constants locally', () => {
    // The consts were duplicated in browser-tools.ts and diagnostics-tools.ts
    // before they were hoisted; a local shadow would silently diverge from the
    // audited source, so forbid it.
    const shadowPattern = /const\s+(READ_ONLY|MUTATING)_ANNOTATIONS\s*=/;
    const offenders = collectToolFiles()
      .filter((filePath) => shadowPattern.test(fs.readFileSync(filePath, 'utf-8')))
      .map((filePath) => path.basename(filePath))
      .sort();
    expect(
      offenders,
      `These files redefine READ_ONLY_ANNOTATIONS / MUTATING_ANNOTATIONS locally. Import them from `
        + `src/main/agent/mcp-http/annotations.ts instead:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('tools named with a mutating verb are annotated MUTATING_ANNOTATIONS', () => {
    // The worst failure mode is a mutation marked read-only (auto-approved in
    // plan mode). Prefix-anchored and one-directional: a create/update/delete/
    // move/promote/link tool must be mutating; read-only tools are unconstrained.
    const dishonest = toolRegistrations
      .filter((registration) => MUTATING_NAME_PREFIXES.some((prefix) => registration.name.startsWith(prefix)))
      .filter((registration) => registration.annotation !== 'MUTATING_ANNOTATIONS')
      .map((registration) => `${registration.file}: ${registration.name} (is ${registration.annotation ?? 'unannotated'})`)
      .sort();
    expect(
      dishonest,
      `These tools have a mutating-verb name but are not annotated MUTATING_ANNOTATIONS. A mutation `
        + `marked read-only is silently auto-approved in plan mode:\n${dishonest.join('\n')}`,
    ).toEqual([]);
  });
});

/**
 * Browser-tool capability-tier annotation parity.
 *
 * The "mutating verb" check above only recognizes the
 * kangentic_create_/update_/delete_/move_/promote_/link_ board-mutation
 * prefixes, so it structurally cannot see the kangentic_browser_* family:
 * none of navigate/click/type/keypress/drag/eval start with a recognized
 * verb, yet every one of them mutates the user's loaded page (a click, a
 * keystroke, a navigation, arbitrary eval). A future edit that flipped one of
 * these to READ_ONLY_ANNOTATIONS would pass every existing assertion in this
 * file and be silently auto-approved in plan mode - exactly the worst failure
 * mode the annotation system exists to prevent.
 *
 * browser-tools.ts documents four capability tiers ("observe (screenshot,
 * query, console, wait), interact (click/type/keypress/drag), navigate,
 * eval") and every tool passes its tier as the first argument to the shared
 * `drive(<capability>, ...)` gate (see .claude/rules/browser-automation-driver.md,
 * "every CDP-driving tool routes through withGuest and declares its
 * capability tier"). That capability string is an independent,
 * architecturally load-bearing signal - withGuest uses it to gate
 * interaction, unrelated to the MCP `annotations:` field - so deriving the
 * expected annotation from it (rather than hand-listing tool names) keeps
 * this check honest and self-maintaining as tools are renamed or added.
 * The one non-`drive`-calling tool, kangentic_browser_list_panes, is a pure
 * registry read (discovery), so it is expected read-only too.
 */
describe('mcp browser tool capability-tier annotation parity', () => {
  const BROWSER_TOOLS_PATH = path.join(MCP_HTTP_DIR, 'browser-tools.ts');

  interface BrowserToolCapability {
    name: string;
    /** The capability literal passed to drive(), or 'discovery' for the one tool with no drive() call. */
    capability: string;
    annotation: SharedAnnotationToken | null;
  }

  function collectBrowserToolCapabilities(): BrowserToolCapability[] {
    const content = fs.readFileSync(BROWSER_TOOLS_PATH, 'utf-8');
    const namePattern = /registerTool\(\s*(['"])([^'"]+)\1/g;
    const annotationPattern = /annotations:\s*(READ_ONLY_ANNOTATIONS|MUTATING_ANNOTATIONS)\b/;
    const capabilityPattern = /\bdrive(?:<[^>]*>)?\(\s*(['"])([^'"]+)\1/;
    const matches = [...content.matchAll(namePattern)];
    const results: BrowserToolCapability[] = [];
    for (let index = 0; index < matches.length; index += 1) {
      const start = matches[index].index ?? 0;
      const end = index + 1 < matches.length ? (matches[index + 1].index ?? content.length) : content.length;
      const segment = content.slice(start, end);
      const annotationMatch = segment.match(annotationPattern);
      const capabilityMatch = segment.match(capabilityPattern);
      results.push({
        name: matches[index][2],
        capability: capabilityMatch ? capabilityMatch[2] : 'discovery',
        annotation: annotationMatch ? (annotationMatch[1] as SharedAnnotationToken) : null,
      });
    }
    return results;
  }

  it('finds the browser tools (regex did not silently miss the file)', () => {
    // Guards the check below: if this regresses to 0, every filter() in the
    // next test would vacuously pass and hide a real annotation flip.
    expect(collectBrowserToolCapabilities().length).toBeGreaterThan(0);
  });

  it('every browser tool is annotated per its documented capability tier', () => {
    const capabilities = collectBrowserToolCapabilities();
    const mismatched = capabilities
      .filter((tool) => {
        const expectedAnnotation: SharedAnnotationToken =
          tool.capability === 'observe' || tool.capability === 'discovery'
            ? 'READ_ONLY_ANNOTATIONS'
            : 'MUTATING_ANNOTATIONS';
        return tool.annotation !== expectedAnnotation;
      })
      .map((tool) => `${tool.name} (capability=${tool.capability}, annotation=${tool.annotation ?? 'unannotated'})`)
      .sort();
    expect(
      mismatched,
      `These kangentic_browser_* tools are annotated inconsistently with their capability tier. `
        + `observe/discovery tools (no page side effects) must be READ_ONLY_ANNOTATIONS; `
        + `interact/navigate/eval tools (mutate the user's loaded page) must be `
        + `MUTATING_ANNOTATIONS:\n${mismatched.join('\n')}`,
    ).toEqual([]);
  });
});
