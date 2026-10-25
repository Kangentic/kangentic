/**
 * Terminal input and echo never cross main (task #900). A keystroke and its
 * echo used to ride main's IPC (`session:write` in, `session:data` out, with
 * `session:drainAck` for backpressure), so a git start, a database write or a
 * burst of IPC on main froze every terminal's typing. Each renderer now has its
 * own port to the pty host (`src/preload/pty-port-client.ts`), the host runs the
 * write queue and the draft ledger, and main brokers the port and never relays.
 *
 * These are source pins: the unit tier has no preload or renderer to run, so
 * they fail when the old path comes back rather than when it misbehaves.
 * `pty-host-core.test.ts` and `pty-port-client.test.ts` pin the behavior.
 *
 * Tier: Unit.
 */
import fs from 'node:fs';
import path from 'node:path';
import * as ts from 'typescript';
import { describe, it, expect } from 'vitest';
import { IPC } from '../../src/shared/ipc-channels';

const ROOT = path.resolve(__dirname, '..', '..');
const read = (relative: string): string => fs.readFileSync(path.join(ROOT, relative), 'utf8');

function listSourceFiles(relativeDirectory: string): string[] {
  const found: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(fullPath);
      else if (/\.tsx?$/.test(entry.name)) found.push(fullPath);
    }
  };
  walk(path.join(ROOT, relativeDirectory));
  return found;
}

/** The line, without a trailing comment, unless the whole line is a comment. */
function codeOf(line: string): string {
  const trimmed = line.trim();
  if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return '';
  return line;
}

describe('terminal input and echo never cross main', () => {
  it('has no IPC channel for a keystroke, the echo, or its ack', () => {
    const channelNames = Object.keys(IPC);
    const channelValues: string[] = Object.values(IPC);
    for (const name of ['SESSION_WRITE', 'SESSION_DATA', 'SESSION_DRAIN_ACK']) expect(channelNames).not.toContain(name);
    for (const value of ['session:write', 'session:data', 'session:drainAck']) expect(channelValues).not.toContain(value);
  });

  it('main never emits a renderer "data" event, and the IPC layer listens for none', () => {
    const offenders: string[] = [];
    for (const file of [...listSourceFiles('src/main/pty'), ...listSourceFiles('src/main/ipc')]) {
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, index) => {
        const code = codeOf(line);
        if (/\b(emit|on|once)\(\s*'data'/.test(code) && /(this|sessionManager|manager)\.(emit|on|once)\(\s*'data'/.test(code)) {
          offenders.push(`${path.relative(ROOT, file)}:${index + 1}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  it('the host core sends a renderer its output on its port, never as an event to main', () => {
    const core = read('src/main/pty/host/pty-host-core.ts');
    expect(core).not.toMatch(/emit\(\{\s*type:\s*'data'/);
    expect(core).toMatch(/postToRenderersShowing\(/);
  });

  it('the preload writes, listens and acks on the port, never through ipcRenderer', () => {
    const source = read('src/preload/preload.ts');
    const sourceFile = ts.createSourceFile('preload.ts', source, ts.ScriptTarget.Latest, true);
    const sessionsMembers = new Map<string, string>();
    const visit = (node: ts.Node): void => {
      if (ts.isPropertyAssignment(node) && node.name.getText(sourceFile) === 'sessions' && ts.isObjectLiteralExpression(node.initializer)) {
        for (const property of node.initializer.properties) {
          if (ts.isPropertyAssignment(property)) sessionsMembers.set(property.name.getText(sourceFile), property.initializer.getText(sourceFile));
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);

    // The scan must have found the block, or every assertion below passes vacuously.
    expect(sessionsMembers.size).toBeGreaterThan(10);
    for (const member of ['write', 'onData', 'ackData', 'getScrollback']) {
      const body = sessionsMembers.get(member);
      expect(body, `sessions.${member}`).toBeDefined();
      expect(body, `sessions.${member}`).not.toMatch(/ipcRenderer/);
      expect(body, `sessions.${member}`).toMatch(/ptyPortClient\./);
    }
  });

  it('main brokers each renderer a port and hands the host its end', () => {
    const handlers = read('src/main/ipc/handlers/sessions.ts');
    expect(handlers).toMatch(/new MessageChannelMain\(\)/);
    expect(handlers).toMatch(/sessionManager\.attachRendererPort\(/);
    expect(handlers).toMatch(/postMessage\(IPC\.PTY_PORT,/);
    expect(handlers).toMatch(/ipcMain\.on\(IPC\.PTY_PORT_REQUEST,/);
    // A restarted host lost every port: the IPC layer issues new ones.
    expect(handlers).toMatch(/sessionManager\.on\('renderer-ports-lost',/);
  });

  it('useTerminal asks for the scrollback only once its grid request has resolved, and resolves the replay off the scrollback alone', () => {
    const source = read('src/renderer/hooks/useTerminal.ts');
    const calls = [...source.matchAll(/window\.electronAPI\.sessions\.getScrollback\(/g)].map((match) => match.index ?? 0);
    // The mount replay and the reload replay.
    expect(calls).toHaveLength(2);
    for (const callIndex of calls) {
      const statementStart = source.lastIndexOf('const scrollbackPromise =', callIndex);
      expect(statementStart).toBeGreaterThan(-1);
      const statement = source.slice(statementStart, callIndex);
      // Same statement, chained after the grid request: the port's answer can
      // never beat main's resize answer and resolve the replay before it.
      expect(statement).not.toContain(';');
      expect(statement).toMatch(/(requestGrid\([^)]*\)|gridPromise)\.then\(/);
    }
    expect(source).not.toMatch(/Promise\.all\(\[[^\]]*scrollbackPromise/);
  });

  it('leaves Chromium\'s deferral after input on: turning it off made drag drops paint late', () => {
    // Off, the echo lands a frame sooner at idle, but React's scheduler posts
    // through a MessageChannel too, and six measured drags then painted their
    // drop 15 to 62 ms after release with seven long frames, against 29 to
    // 40 ms and none with it on (docs/architecture/sessions/output-streaming.md).
    const offenders = listSourceFiles('src/main')
      .filter((file) => fs.readFileSync(file, 'utf8').includes('DeferRendererTasksAfterInput'))
      .map((file) => path.relative(ROOT, file));
    expect(offenders).toEqual([]);
  });

  it('every kill path seals the PTY to the renderers\' keystrokes before it drops the handle', () => {
    // The exit handler drops a PTY that is already gone: the host closed its
    // write path when the process exited, so there is nothing left to seal.
    const allowed = new Set(['src/main/pty/lifecycle/session-spawn-flow.ts#exit']);
    const unsealed: string[] = [];
    let sites = 0;
    for (const file of listSourceFiles('src/main/pty')) {
      const relative = path.relative(ROOT, file).split(path.sep).join('/');
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, index) => {
        if (!/\.pty = null\b/.test(codeOf(line))) return;
        sites++;
        const before = lines.slice(Math.max(0, index - 3), index).join('\n');
        if (/sealUserInput\(\)/.test(before)) return;
        const inExitHandler = /exitCode = resolvedExitCode/.test(lines.slice(Math.max(0, index - 3), index).join('\n'));
        if (inExitHandler && allowed.has(`${relative}#exit`)) return;
        unsealed.push(`${relative}:${index + 1}`);
      });
    }
    // kill(), the suspend's clear, the quit's shutdown, the respawn's sibling
    // kill, and the exit handler.
    expect(sites).toBeGreaterThanOrEqual(5);
    expect(unsealed).toEqual([]);
  });
});
