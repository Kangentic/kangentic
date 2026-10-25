/**
 * AppLayout sits above almost every component in the app and memoizes none of
 * its children, so whatever it subscribes to decides how much of the app a store
 * change re-renders. Two subscriptions made a task window's maximize re-render
 * the whole app: `useFocusedSessionsSync`, which keys on every window's state,
 * called from AppLayout itself (measured: 296 components, 42 ms, before the PTY
 * resize could go out), and the whole `config` and `globalConfig` objects, which
 * the store rebuilds on every write, the window layout save half a second after
 * each maximize included (243 components, 16 ms). These pin both out of
 * AppLayout's own body.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/components/layout/AppLayout.tsx'), 'utf8');

/** The body of `export function AppLayout`, up to the end of the file. */
const appLayoutBody = source.slice(source.indexOf('export function AppLayout('));

describe('AppLayout render scope', () => {
  it('finds the component it checks', () => {
    expect(appLayoutBody.length).toBeGreaterThan(1000);
  });

  it('subscribes to no whole config object, only the values it reads', () => {
    expect(appLayoutBody).not.toMatch(/useConfigStore\(\s*\(\s*\w+\s*\)\s*=>\s*\w+\.(config|globalConfig)\s*\)/);
  });

  it('calls useFocusedSessionsSync only from its own component, never from AppLayout\'s body', () => {
    expect(appLayoutBody).not.toMatch(/useFocusedSessionsSync\(/);
    expect(source).toMatch(/function FocusedSessionsSync\([^)]*\)[^{]*\{\s*useFocusedSessionsSync\(/);
    expect(appLayoutBody).toMatch(/<FocusedSessionsSync /);
  });
});
