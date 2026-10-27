/**
 * Main loads the three hook bridges for a CLI installed in a WSL distro
 * (`wsl-hook-inbox.ts` runs their exported logic), so loading one must touch
 * nothing in the process. Before the refactor, `event-bridge.js` replaced
 * `process.stdout.write` at load, which would have silenced main's own output,
 * and every bridge read `process.argv` and attached a stdin listener.
 *
 * Red-green: moving the stdout guard, the argv read or the stdin listener back
 * out of a bridge's `require.main === module` block fails these.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';

const requireFromHere = createRequire(__filename);
const BRIDGES = ['event-bridge.js', 'plan-approval-bridge.js', 'background-shell-hint-bridge.js'];

describe('loading a hook bridge as a module', () => {
  it.each(BRIDGES)('%s leaves stdout and stdin alone and exports its logic', (bridge) => {
    const writeBefore = process.stdout.write;
    const dataListenersBefore = process.stdin.listenerCount('data');
    const endListenersBefore = process.stdin.listenerCount('end');

    const exported = requireFromHere(path.join(process.cwd(), 'src', 'main', 'agent', bridge)) as Record<string, unknown>;

    expect(process.stdout.write).toBe(writeBefore);
    expect(process.stdin.listenerCount('data')).toBe(dataListenersBefore);
    expect(process.stdin.listenerCount('end')).toBe(endListenersBefore);
    expect(Object.values(exported).some((value) => typeof value === 'function')).toBe(true);
  });
});
