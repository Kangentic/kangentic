/**
 * build/spawn-helper/spawn-helper.c replaces node-pty's macOS spawn-helper in
 * the packaged app (build/install-spawn-helper.js). Every macOS terminal runs
 * through it, and node-pty decides its argv layout, so the replacement is only
 * correct while it matches the node-pty we install.
 *
 * These checks run on Linux CI, where the helper cannot be compiled, so a
 * node-pty bump that changes the helper or how node-pty calls it fails here
 * instead of breaking every macOS terminal in a release:
 * - our source, minus its `kangentic:` blocks, is upstream's
 *   src/unix/spawn-helper.cc;
 * - node-pty still resolves the helper as `native.dir + '/spawn-helper'`, the
 *   file afterPack overwrites;
 * - pty.cc still passes [helper, cwd, file, ...args].
 *
 * Tier: Unit.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const NODE_PTY_ROOT = path.dirname(require.resolve('node-pty/package.json'));
const REPOSITORY_ROOT = path.join(__dirname, '..', '..');
const KANGENTIC_HELPER_SOURCE = path.join(REPOSITORY_ROOT, 'build', 'spawn-helper', 'spawn-helper.c');

const KANGENTIC_BLOCK = /\/\/ kangentic:begin[^\n]*\n[\s\S]*?\/\/ kangentic:end[^\n]*\n?/g;

function readText(filePath: string): string {
  return fs.readFileSync(filePath, 'utf8');
}

/** Drops comments and collapses whitespace, so only the code is compared. */
function normalizeCode(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

describe('Kangentic spawn-helper matches the installed node-pty', () => {
  const kangenticSource = readText(KANGENTIC_HELPER_SOURCE);

  it('adds only its fenced exception-port reset to upstream spawn-helper.cc', () => {
    const upstreamSource = readText(path.join(NODE_PTY_ROOT, 'src', 'unix', 'spawn-helper.cc'));
    const withoutKangenticBlocks = kangenticSource.replace(KANGENTIC_BLOCK, '');

    // Guard against a vacuous pass: the blocks exist and removing them changes the code.
    expect(kangenticSource.match(KANGENTIC_BLOCK)).toHaveLength(2);
    expect(normalizeCode(withoutKangenticBlocks)).not.toBe(normalizeCode(kangenticSource));

    expect(normalizeCode(withoutKangenticBlocks)).toBe(normalizeCode(upstreamSource));
  });

  it('clears every task exception port inside the fenced block, before exec', () => {
    const blocks = kangenticSource.match(KANGENTIC_BLOCK) ?? [];
    const resetBlock = blocks.find((block) => block.includes('task_set_exception_ports'));
    expect(resetBlock).toBeDefined();
    // EXC_MASK_ALL alone leaves out EXC_MASK_CRASH, the port Crashpad claims,
    // so a reset without it would leave every PTY child reporting to Crashpad.
    expect(normalizeCode(resetBlock ?? '')).toContain(
      'task_set_exception_ports(mach_task_self(), EXC_MASK_ALL | EXC_MASK_CRASH, MACH_PORT_NULL, EXCEPTION_DEFAULT, THREAD_STATE_NONE);',
    );
    expect(kangenticSource.indexOf('task_set_exception_ports')).toBeLessThan(kangenticSource.indexOf('execvp('));
  });

  it("the probe's check reads the EXC_CRASH port its harness installs, so the control step can see inheritance", () => {
    const probeSource = normalizeCode(
      readText(path.join(REPOSITORY_ROOT, 'build', 'spawn-helper', 'exception-port-probe.c')),
    );
    expect(probeSource).toContain('mach_task_self(), EXC_MASK_CRASH, exception_port,');
    expect(probeSource).toContain(
      'task_get_exception_ports( mach_task_self(), EXC_MASK_ALL | EXC_MASK_CRASH, masks,',
    );
  });

  it('node-pty still resolves the helper beside the native module, the file afterPack replaces', () => {
    const unixTerminal = readText(path.join(NODE_PTY_ROOT, 'lib', 'unixTerminal.js'));
    expect(unixTerminal).toContain("var helperPath = native.dir + '/spawn-helper';");
    expect(unixTerminal).toContain("helperPath = helperPath.replace('app.asar', 'app.asar.unpacked');");
  });

  it('node-pty still passes the helper [helper, cwd, file, ...args] on macOS', () => {
    const ptySource = readText(path.join(NODE_PTY_ROOT, 'src', 'unix', 'pty.cc'));
    expect(ptySource).toContain('argv[0] = strdup(helper_path.c_str());');
    expect(ptySource).toContain('argv[1] = strdup(cwd_.c_str());');
    expect(ptySource).toContain('argv[2] = strdup(file.c_str());');
    expect(ptySource).toContain('argv[i + 3] = strdup(arg.c_str());');
  });
});
