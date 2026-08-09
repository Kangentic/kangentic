import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// The window-manager engine is mounted once PER LAYER (board task-detail, Command
// Terminal, Agent Monitor). Each layer gets its instance from React context
// (`useLayerStore()`), except that `window-store.ts` also exports the board's store
// as the module singleton `useWindowStore` for back-compat. That singleton is a
// trap for anything mounted inside a layer: it compiles, it type-checks, and it is
// silently correct for the board and silently wrong for every other layer.
//
// It shipped twice, both times as a bug the user hit:
//
//   1. `useClickOutsideToClose` resolved its dismiss targets from the board store,
//      so a click on the Agent Monitor's dead space closed nothing (the monitor's
//      windows were in the monitor's store) - and, before the surfaces were scoped,
//      reached PAST the monitor to close the board's windows underneath it.
//   2. `useWindowSessionClaims` re-derived `dialogSessionIds` - which is
//      renderer-GLOBAL, not per-layer - from the board's windows alone. It was
//      therefore authoritative over claims it could not see, and erased the
//      monitor's a frame after the monitor made it. The bottom terminal panel then
//      re-mounted an xterm for a PTY a monitor window was already showing: two
//      fitters on one terminal, each resizing it to a different width, which reads
//      as a frozen, overflowing terminal.
//
// These scans are the backstop. Neither failure mode is visible from the board,
// which is why review and manual testing both missed them.

const REPO_ROOT = path.resolve(__dirname, '../..');

function read(relativePath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf-8');
}

/** Strip comments so prose ABOUT the singleton never trips a scan. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
}

describe('window-manager layer isolation', () => {
  describe('layer-mounted bridges never reach for the board singleton', () => {
    // Bridges mounted inside more than one layer's provider. A bridge mounted ONLY
    // by the board (useWorkspacePersistence, useTaskDetailWindowBridge) is
    // deliberately board-specific and not listed here.
    const MULTI_LAYER_BRIDGES = [
      'src/renderer/window-manager/bridge/useClickOutsideToClose.ts',
    ];

    it.each(MULTI_LAYER_BRIDGES)('%s uses the layer store, not useWindowStore', (relativePath) => {
      const source = stripComments(read(relativePath));

      expect(
        source,
        `${relativePath} imports the board's module singleton. A bridge mounted in more than one `
        + 'layer must read its store from context via useLayerStore(), or it silently operates on '
        + "the board's windows no matter which layer mounted it.",
      ).not.toMatch(/\buseWindowStore\b/);

      expect(
        source,
        `${relativePath} must call useLayerStore() to resolve its layer's store.`,
      ).toMatch(/\buseLayerStore\b/);
    });
  });

  describe('renderer-global claim reconciliation covers every layer', () => {
    it('allWindowManagers lists every exported manager instance', () => {
      const source = read('src/renderer/window-manager/store/window-store.ts');

      const exportedManagers = [...source.matchAll(/^export const (\w*[Ww]indowManager) =/gm)]
        .map((match) => match[1]);
      expect(exportedManagers.length).toBeGreaterThanOrEqual(3);

      const listBody = source.split('export const allWindowManagers')[1]?.split('];')[0] ?? '';
      expect(listBody, 'allWindowManagers is missing or malformed').not.toBe('');

      for (const manager of exportedManagers) {
        expect(
          listBody,
          `${manager} is not in allWindowManagers. \`dialogSessionIds\` is renderer-global, so a `
          + 'reconciler that misses a layer treats that layer\'s claims as stale and erases them, '
          + 'putting a second xterm on a live PTY.',
        ).toContain(manager);
      }
    });

    it('TERMINAL_WINDOW_LAYERS covers every manager in allWindowManagers', () => {
      // `dictation-target.ts` keeps its OWN ordered list rather than iterating
      // allWindowManagers, because the order is load-bearing there: it resolves
      // the front-most focused layer first (command over monitor over board),
      // while allWindowManagers is an unordered set. The ORDER may differ; the
      // MEMBERSHIP may not. A manager missing from the terminal list makes
      // `resolveFocusedWindowTerminal()` blind to that layer, which costs twice:
      // dictation's priority 1 skips it, and the arrival-focus arbiter's tier 2
      // reports "no focused window" for a window the user is actually working
      // in, falls through to tier 3, and lets an unrelated arriving terminal
      // steal focus - the exact race terminal-arrival-focus.ts exists to close.
      const windowStore = read('src/renderer/window-manager/store/window-store.ts');
      const dictationTarget = read('src/renderer/utils/dictation-target.ts');

      // Same extraction as the membership test above: the exported instance
      // names, not a loose scan of the list body (which also matches the bare
      // `WindowManager` type annotation and would pass vacuously).
      const exportedManagers = [...windowStore.matchAll(/^export const (\w*[Ww]indowManager) =/gm)]
        .map((match) => match[1]);
      expect(exportedManagers.length).toBeGreaterThanOrEqual(3);

      const terminalListBody = dictationTarget.split('const TERMINAL_WINDOW_LAYERS')[1]?.split('];')[0] ?? '';
      expect(
        terminalListBody,
        'TERMINAL_WINDOW_LAYERS is missing or malformed in dictation-target.ts',
      ).not.toBe('');

      for (const manager of exportedManagers) {
        expect(
          terminalListBody,
          `${manager} is in allWindowManagers but not in TERMINAL_WINDOW_LAYERS `
          + '(src/renderer/utils/dictation-target.ts). resolveFocusedWindowTerminal() would not '
          + 'walk that layer, so a focused window there is invisible to BOTH voice dictation and '
          + 'the arrival-focus arbiter, and an unrelated terminal can steal its keyboard focus.',
        ).toContain(manager);
      }
    });

    it('useWindowSessionClaims reconciles across all managers, not one store', () => {
      const source = stripComments(read('src/renderer/window-manager/bridge/useWindowSessionClaims.ts'));

      expect(source, 'useWindowSessionClaims must iterate allWindowManagers').toMatch(
        /\ballWindowManagers\b/,
      );
      expect(
        source,
        'useWindowSessionClaims must not read the board singleton: it would erase other layers\' claims.',
      ).not.toMatch(/\buseWindowStore\b/);
    });

    it('resolves a window\'s taskId through its manager\'s anchor decoder', () => {
      // The board anchors task-detail windows BY taskId; the monitor by
      // `projectId:taskId`. A reconciler comparing `session.taskId === anchor`
      // therefore matches board windows and NEVER monitor ones - the union above
      // would be correct and still reconcile to nothing.
      const source = stripComments(read('src/renderer/window-manager/bridge/useWindowSessionClaims.ts'));
      expect(
        source,
        'useWindowSessionClaims must decode each window\'s anchor via options.anchorToTaskId, or '
        + 'monitor windows silently never match a session.',
      ).toMatch(/anchorToTaskId/);
    });
  });

  describe('the monitor layer\'s focus publisher is gated on the same signal that mounts it', () => {
    // Only ONE thing per renderer may publish the focused-session set:
    // `SESSION_SET_FOCUSED` is a whole-set replace keyed on the sender's
    // webContents id, so two publishers in one renderer fight and the loser's
    // terminals go silent. In the main window that publisher is
    // `useFocusedSessionsSync`; in a detached monitor there is none, so the layer
    // publishes for itself, gated on `readPopOutDescriptor()`.
    //
    // That gate is only safe because `index.tsx` selects the pop-out root with the
    // SAME call: a detached monitor cannot exist in a renderer where the
    // descriptor is null. If index.tsx ever switches to a different signal, the
    // gate could read null in a real pop-out and silence every terminal in it -
    // strictly worse than the bug the gate was added for.
    it('index.tsx mounts the pop-out root on readPopOutDescriptor()', () => {
      const entry = stripComments(read('src/renderer/index.tsx'));
      expect(entry).toMatch(/readPopOutDescriptor\(\)/);
      expect(
        entry,
        'index.tsx must gate PopOutSurfaceRoot on the descriptor value that '
        + 'MonitorDetailLayer also reads to decide whether it owns focus publishing.',
      ).toMatch(/popOutDescriptor\s*\?[\s\S]{0,200}PopOutSurfaceRoot/);
    });

    it('the monitor layer publishes focus only when detached', () => {
      const source = stripComments(read('src/renderer/components/monitor/MonitorDetailLayer.tsx'));
      const publisher = source.split('setFocused')[0] ?? '';
      expect(
        publisher,
        'The monitor layer must not publish a focused set in the main window, where '
        + 'useFocusedSessionsSync already does - the second publisher clobbers the first.',
      ).toMatch(/readPopOutDescriptor/);
    });
  });

  describe('light-dismiss scopes are named per layer', () => {
    /** The hook READS the marker (`closest('[data-dismiss-layer]')`); it does not declare one,
     *  so it is not a marker site and must not be scanned as one. Matched by path suffix: if
     *  the hook is ever moved or renamed, update this too, or the scan reads its bare
     *  `closest('[data-dismiss-layer]')` as an unscoped declaration and fails with a
     *  "name the layer" message that points nowhere near the real cause. */
    const MARKER_CONSUMER = 'window-manager/bridge/useClickOutsideToClose.ts';

    /** Every `data-dismiss-layer` DECLARATION in the renderer, as `path:line: source`. */
    const collectScopeMarkerLines = (): string[] => {
      const RENDERER = path.join(REPO_ROOT, 'src/renderer');
      const found: string[] = [];

      const walk = (directory: string): void => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
          const entryPath = path.join(directory, entry.name);
          if (entry.isDirectory()) { walk(entryPath); continue; }
          if (!/\.tsx?$/.test(entry.name)) continue;
          if (entryPath.replace(/\\/g, '/').endsWith(MARKER_CONSUMER)) continue;

          const lines = fs.readFileSync(entryPath, 'utf-8').split('\n');
          lines.forEach((line, index) => {
            const trimmed = line.trim();
            // Prose about the attribute (line comments, block comments, JSX
            // comments, and backtick-quoted mentions inside them) is not a usage.
            // The prefix check below only sees how THIS line starts, so a continuation
            // line inside a multi-line `{/* ... */}` block does not read as a comment. The
            // backtick strip below is what actually covers those, which makes
            // backtick-wrapping every prose mention of the attribute load-bearing for
            // this scan: an unwrapped mention on a continuation line counts as a
            // declaration and fails the exact-file-set assertion below.
            if (/^(\/\/|\*|\/\*|\{\/\*)/.test(trimmed)) return;
            const code = line.replace(/`[^`]*`/g, '');
            if (!/data-dismiss-layer/.test(code)) return;
            found.push(`${path.relative(REPO_ROOT, entryPath).replace(/\\/g, '/')}:${index + 1}: ${trimmed}`);
          });
        }
      };
      walk(RENDERER);
      return found;
    };

    it('every data-dismiss-layer names its layer', () => {
      // Valid: `data-dismiss-layer="board"`, or a conditional resolving to a scope
      // string. Invalid: the bare boolean attribute, which matches EVERY layer's hook
      // and let one layer dismiss another's windows.
      const offenders = collectScopeMarkerLines().filter(
        (entry) => !/data-dismiss-layer\s*=/.test(entry),
      );

      expect(
        offenders,
        'A bare `data-dismiss-layer` is layer-agnostic, so a click on it dismisses windows in '
        + 'EVERY layer - including layers stacked above or below the surface the user clicked. '
        + 'Name the layer: `data-dismiss-layer="board"`. Offenders:\n' + offenders.join('\n'),
      ).toEqual([]);
    });

    it('the scope marker is actually present, so the scan cannot pass vacuously', () => {
      // Light dismiss is a DENYLIST: the marked subtree dismisses unless an element is
      // excluded. So the marker's ABSENCE is not the safe state it was under the old
      // allowlist - it silently disables background-close for that whole layer, and the
      // bare-attribute scan above would still pass on zero occurrences. Pin the sites.
      const markerLines = collectScopeMarkerLines();
      const markedFiles = new Set(markerLines.map((entry) => entry.split(':')[0]));

      // One marker per HOST, not per component. The monitor has TWO hosts that do not share a
      // root: the in-app overlay (MonitorPage) and the pop-out window (PopOutMonitorRoot,
      // which renders LazyMonitor + MonitorDetailLayer WITHOUT MonitorPage). Both mount the
      // hook via MonitorDetailLayer, so both need a scope root or one of them silently stops
      // dismissing - which is exactly what happened when the marker was moved up off
      // MonitorBody's scroller, the one element both hosts did share.
      expect(
        [...markedFiles].sort(),
        'The light-dismiss scope marker must exist on the board shell (AppLayout\'s content row '
        + 'and StatusBar, which sits outside it) and on BOTH monitor hosts (the in-app overlay '
        + 'and the pop-out root). Losing one silently turns background-close off for that host. '
        + 'Found:\n' + markerLines.join('\n'),
      ).toEqual([
        'src/renderer/components/layout/AppLayout.tsx',
        'src/renderer/components/layout/StatusBar.tsx',
        'src/renderer/components/monitor/MonitorPage.tsx',
        'src/renderer/pop-out/roots/PopOutMonitorRoot.tsx',
      ]);
    });

    it('every marker site names the RIGHT scope, not just some scope', () => {
      // The two tests above pin that a marker exists and that it names SOME layer, but
      // neither catches a marker naming the WRONG one - e.g. MonitorPage or
      // PopOutMonitorRoot accidentally scoped `"board"`. That is a worse bug than a missing
      // marker: a click on the monitor overlay would then resolve to the BOARD's window
      // store and close a board window sitting behind the monitor - the exact bug this
      // scoping was introduced to prevent (see the file header) - while a click on the
      // board would resolve to a store no board window is ever added to, silently
      // disabling background-close there instead.
      const EXPECTED_SCOPE_BY_FILE: Record<string, string> = {
        'src/renderer/components/layout/AppLayout.tsx': 'board',
        'src/renderer/components/layout/StatusBar.tsx': 'board',
        'src/renderer/components/monitor/MonitorPage.tsx': 'monitor',
        'src/renderer/pop-out/roots/PopOutMonitorRoot.tsx': 'monitor',
      };

      const markerLines = collectScopeMarkerLines();
      const offenders: string[] = [];

      for (const [file, expectedScope] of Object.entries(EXPECTED_SCOPE_BY_FILE)) {
        const line = markerLines.find((entry) => entry.startsWith(`${file}:`));
        // A missing entry here already fails the "actually present" test above; this
        // test only has something to check once the site exists.
        if (!line) continue;
        // Only a literal string value is statically checkable. A conditional
        // (`data-dismiss-layer={someExpr}`) already passed the "names its layer" test
        // above by containing `=`; resolving what it evaluates to needs the runtime
        // tree, so it is left to `tests/ui/window-click-outside-close.spec.ts` and
        // `tests/ui/agent-monitor.spec.ts` rather than flagged here as unresolvable.
        const literalMatch = /data-dismiss-layer\s*=\s*"(\w+)"/.exec(line);
        if (!literalMatch) continue;
        if (literalMatch[1] !== expectedScope) {
          offenders.push(`${line} (expected "${expectedScope}")`);
        }
      }

      expect(
        offenders,
        'A marker site names the wrong layer for its host. Offenders (expected scope in '
        + 'parens):\n' + offenders.join('\n'),
      ).toEqual([]);
    });

    it('the retired allowlist attribute does not come back', () => {
      // `data-dismiss-surface` was the OPPOSITE polarity: an allowlist of five regions
      // that dismissed, with everything else inert. Reintroducing it alongside the
      // denylist would leave two disagreeing mechanisms, and the hook no longer reads it.
      const RENDERER = path.join(REPO_ROOT, 'src/renderer');
      const offenders: string[] = [];

      const walk = (directory: string): void => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
          const entryPath = path.join(directory, entry.name);
          if (entry.isDirectory()) { walk(entryPath); continue; }
          if (!/\.tsx?$/.test(entry.name)) continue;

          const lines = fs.readFileSync(entryPath, 'utf-8').split('\n');
          lines.forEach((line, index) => {
            const trimmed = line.trim();
            if (/^(\/\/|\*|\/\*|\{\/\*)/.test(trimmed)) return;
            const code = line.replace(/`[^`]*`/g, '');
            if (!/data-dismiss-surface/.test(code)) return;
            offenders.push(`${path.relative(REPO_ROOT, entryPath).replace(/\\/g, '/')}:${index + 1}: ${trimmed}`);
          });
        }
      };
      walk(RENDERER);

      expect(
        offenders,
        '`data-dismiss-surface` is retired. Light dismiss is now a denylist scoped by '
        + '`data-dismiss-layer`; nothing reads the old allowlist attribute. Offenders:\n'
        + offenders.join('\n'),
      ).toEqual([]);
    });
  });
});
