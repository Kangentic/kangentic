/**
 * The dev-only devtools screenshot tools get the caller's capture-copy folder
 * (task #1136), through two hand-offs the unit tier cannot run:
 *
 * - `src/main/agent/mcp-http-server.ts` registers them inside
 *   `if (__KANGENTIC_DEV__)`, which vitest compiles to false;
 * - `src/devtools/mcp/register.ts` forwards the folder to the preview tools.
 *
 * What a user loses if either goes: the `kangentic_devtools_screenshot*` tools
 * would silently stop naming a copy in the caller's folder, and the agent would
 * be back to copying out of the tool-results folder and stopping on a permission
 * prompt. The behavior of the copy itself is pinned in
 * `preview-instance-discovery.test.ts`; this pins only the wiring.
 *
 * Tier: Unit (source text, because the dev branch cannot execute here).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '../..');

/** The file with comments dropped, so a comment that quotes a call cannot satisfy a check. */
function codeOf(relativePath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

describe('devtools capture-copy wiring', () => {
  it('the __KANGENTIC_DEV__ block passes the browser tools\' captureCopyDirectory to registerDevtoolsMcpTools', () => {
    const source = codeOf('src/main/agent/mcp-http-server.ts');
    const block = /if \(__KANGENTIC_DEV__\) \{([\s\S]*?)\n  \}/.exec(source);

    expect(block).not.toBeNull();
    const call = /registerDevtoolsMcpTools\(([^;]*)\);/.exec(block![1]);
    expect(call).not.toBeNull();
    const args = call![1].split(',').map((argument) => argument.trim());
    expect(args[0]).toBe('mcpServer');
    expect(args[1]).toBe('resolver');
    expect(args[2]).toMatch(/^browser\.captureCopyDirectory\b/);
  });

  it('registerDevtoolsMcpTools forwards its third argument to registerDevtoolsPreviewTools', () => {
    const source = codeOf('src/devtools/mcp/register.ts');
    const signature = /export function registerDevtoolsMcpTools\(([\s\S]*?)\): void/.exec(source);
    expect(signature).not.toBeNull();
    const parameters = signature![1].split(',').map((parameter) => parameter.trim()).filter(Boolean);
    expect(parameters).toHaveLength(3);
    const thirdName = parameters[2].split(':')[0].trim();

    const call = /registerDevtoolsPreviewTools\(([^;]*)\);/.exec(source);
    expect(call).not.toBeNull();
    const args = call![1].split(',').map((argument) => argument.trim());
    expect(args).toHaveLength(3);
    expect(args[2]).toBe(thirdName);
  });
});
