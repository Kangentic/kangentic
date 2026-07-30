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

  describe('light-dismiss surfaces are scoped to a layer', () => {
    it('every data-dismiss-surface names its layer', () => {
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
            // Prose about the attribute (line comments, block comments, JSX
            // comments, and backtick-quoted mentions inside them) is not a usage.
            if (/^(\/\/|\*|\/\*|\{\/\*)/.test(trimmed)) return;
            const code = line.replace(/`[^`]*`/g, '');
            if (!/data-dismiss-surface/.test(code)) return;
            // Valid: `data-dismiss-surface="board"` or a conditional resolving to a
            // scope string. Invalid: the bare boolean attribute, which matched every
            // layer's hook and let one layer dismiss another's windows.
            if (/data-dismiss-surface\s*=/.test(code)) return;
            offenders.push(`${path.relative(REPO_ROOT, entryPath).replace(/\\/g, '/')}:${index + 1}: ${trimmed}`);
          });
        }
      };
      walk(RENDERER);

      expect(
        offenders,
        'A bare `data-dismiss-surface` is layer-agnostic, so a click on it dismisses windows in '
        + 'EVERY layer - including layers stacked above or below the surface the user clicked. '
        + 'Name the layer: `data-dismiss-surface="board"`. Offenders:\n' + offenders.join('\n'),
      ).toEqual([]);
    });
  });
});
