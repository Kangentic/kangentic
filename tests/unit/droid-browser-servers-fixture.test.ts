/**
 * `droidBrowserServerNames` against an mcp.json in the shape Factory's MCP docs
 * show (tests/fixtures/droid-factory-mcp.json): a stdio server with an `env`
 * `${VAR}` reference, an http server with a `headers` `${VAR}` reference, and
 * Kangentic's own entry. Only the browser-automation server is named, so the
 * browser policy hook denies it and never denies `kangentic`.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { droidBrowserServerNames } from '../../src/main/agent/adapters/droid/browser-servers';
import type { CliTarget } from '../../src/main/agent/shared/cli-target';

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'droid-factory-mcp.json');
const temporaryDirectories: string[] = [];

function makeDirectory(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

/** A place whose home is an empty temp folder, so the real user file is never read. */
function emptyHomePlace(): CliTarget {
  return {
    kind: 'wsl', distro: 'Ubuntu', linuxCliPath: '/home/dev/.local/bin/droid',
    facts: { distro: 'Ubuntu', homeLinux: '/home/dev', homeUnc: makeDirectory('kg-droid-fixture-home-'), uncRoot: '\\\\wsl.localhost\\Ubuntu', interactivePath: '/usr/bin', env: {}, networkingMode: 'mirrored' },
  };
}

describe('droidBrowserServerNames on a Factory-shaped mcp.json', () => {
  it('names only the browser-automation server, not the http server or kangentic', () => {
    const project = makeDirectory('kg-droid-fixture-project-');
    fs.mkdirSync(path.join(project, '.factory'));
    fs.copyFileSync(FIXTURE, path.join(project, '.factory', 'mcp.json'));
    const names = droidBrowserServerNames({ cwd: project, place: emptyHomePlace() });
    expect(names).toEqual(['browser-driver']);
    expect(names).not.toContain('kangentic');
  });
});
