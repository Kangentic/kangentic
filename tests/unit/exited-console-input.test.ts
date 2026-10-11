/**
 * Writing to the console a ConPTY shell left open after it exited on its own
 * (src/main/pty/spawn/exited-console-input.ts). It reaches node-pty's private
 * `_agent.inSocket`, so the last test pins those names in the installed
 * package: an upgrade that renames them fails here rather than leaving an
 * orphaned agent with nobody asking it to exit.
 */
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { writeToExitedConsole } from '../../src/main/pty/spawn/exited-console-input';

function fakeTerminal(input: { writable?: boolean; destroyed?: boolean; throws?: boolean } = {}) {
  const write = vi.fn((_data: string) => {
    if (input.throws) throw new Error('EPIPE');
    return true;
  });
  return { terminal: { _agent: { inSocket: { writable: input.writable ?? true, destroyed: input.destroyed ?? false, write } } }, write };
}

describe('writeToExitedConsole', () => {
  it('writes each part of the exit sequence, in order, to the agent\'s input pipe', () => {
    const { terminal, write } = fakeTerminal();
    expect(writeToExitedConsole(terminal, ['\x03', '/exit\r'])).toBe(true);
    expect(write.mock.calls.map((call) => call[0])).toEqual(['\x03', '/exit\r']);
  });

  it('reports false, and writes nothing, when the pipe is gone or not writable', () => {
    const destroyed = fakeTerminal({ destroyed: true });
    const closed = fakeTerminal({ writable: false });
    expect(writeToExitedConsole(destroyed.terminal, ['/exit\r'])).toBe(false);
    expect(writeToExitedConsole(closed.terminal, ['/exit\r'])).toBe(false);
    expect(destroyed.write).not.toHaveBeenCalled();
    expect(closed.write).not.toHaveBeenCalled();
  });

  it('reports false for a PTY with no ConPTY agent (POSIX) and never throws', () => {
    expect(writeToExitedConsole({}, ['/exit\r'])).toBe(false);
    expect(writeToExitedConsole(null, ['/exit\r'])).toBe(false);
    const failing = fakeTerminal({ throws: true });
    expect(writeToExitedConsole(failing.terminal, ['/exit\r'])).toBe(false);
  });

  it('listens for a late write error on the pipe, which node-pty leaves unheard', () => {
    // A real socket: an 'error' emitted with no listener throws, which in the
    // pty host would end every PTY it holds. Red without the listener.
    class FakeInputSocket extends EventEmitter {
      writable = true;
      destroyed = false;
      write(_data: string): boolean { return true; }
    }
    const inSocket = new FakeInputSocket();
    const terminal = { _agent: { inSocket } };

    expect(writeToExitedConsole(terminal, ['\x03'])).toBe(true);
    expect(() => inSocket.emit('error', new Error('EPIPE'))).not.toThrow();

    // A second ask on the same pipe adds no second listener.
    writeToExitedConsole(terminal, ['/exit\r']);
    expect(inSocket.listenerCount('error')).toBe(1);
  });

  it('matches the private fields of the installed node-pty', () => {
    const nodePtyLib = path.dirname(require.resolve('node-pty/lib/windowsTerminal'));
    const terminalSource = fs.readFileSync(path.join(nodePtyLib, 'windowsTerminal.js'), 'utf-8');
    const agentSource = fs.readFileSync(path.join(nodePtyLib, 'windowsPtyAgent.js'), 'utf-8');
    // WindowsTerminal keeps its agent on `_agent` and writes through `_agent.inSocket`.
    expect(terminalSource).toMatch(/_this\._agent = new windowsPtyAgent_1\.WindowsPtyAgent\(/);
    expect(terminalSource).toContain('this._agent.inSocket.write(data)');
    // The agent exposes its input socket through the `inSocket` getter.
    expect(agentSource).toMatch(/"inSocket", \{\s*get: function \(\) \{ return this\._inSocket; \}/);
  });
});
